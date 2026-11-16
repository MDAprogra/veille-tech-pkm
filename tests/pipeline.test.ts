import assert from "node:assert/strict";
import { test } from "node:test";
import type { Article } from "../src/db/store.js";
import { Store } from "../src/db/store.js";
import type { Llm } from "../src/llm/mistral.js";
import { withRetry } from "../src/llm/mistral.js";
import {
	canonicalUrl,
	cleanText,
	collectFeeds,
	type FeedFetcher,
	type FeedItem,
} from "../src/pipeline/collect.js";
import { parseEnrichment } from "../src/pipeline/enrich.js";
import { runPipeline } from "../src/pipeline/run.js";
import { isActiveHour, mondayKey } from "../src/pipeline/scheduler.js";
import { fakeFeed, fakeLlm, goodReply, pipelineDeps, SOURCE } from "./helpers.js";

const ITEMS = [
	{
		title: "Article <b>un</b>",
		link: "https://a.test/1?utm_source=rss#top",
		content: "<p>Bonjour&nbsp;&amp; bienvenue</p>",
		isoDate: "2026-06-15T08:00:00.000Z",
	},
	{ title: "Article deux", link: "https://a.test/2", contentSnippet: "texte" },
	{ title: "Sans lien" },
];

test("collecte : nettoyage, canonicalisation, sources en échec isolées", async () => {
	assert.equal(
		canonicalUrl("https://a.test/x?utm_source=rss&id=3&fbclid=z#frag"),
		"https://a.test/x?id=3",
	);
	assert.equal(canonicalUrl("pas une url"), "pas une url");
	assert.equal(cleanText("<script>x()</script><p>Un &amp; deux</p>\n  trois"), "Un & deux trois");

	const { articles, failedSources } = await collectFeeds(
		[SOURCE, { ...SOURCE, name: "Cassée", url: "https://ko.test" }],
		async (url) => {
			if (url.includes("ko")) throw new Error("timeout");
			return { items: ITEMS };
		},
	);
	assert.deepEqual(failedSources, ["Cassée"]);
	assert.equal(articles.length, 2);
	assert.equal(articles[0].title, "Article un");
	assert.equal(articles[0].url, "https://a.test/1");
	assert.equal(articles[0].content, "Bonjour & bienvenue");
});

test("pipeline : le LLM n'est appelé que pour les nouveaux articles, notification unique", async () => {
	const store = new Store(":memory:");
	const { llm, calls } = fakeLlm(() => goodReply(5));
	const notified: Article[][] = [];
	const deps = pipelineDeps(store, {
		fetchFeed: fakeFeed(ITEMS),
		llm,
		notify: async (articles) => void notified.push(articles),
	});

	const first = await runPipeline(deps);
	assert.deepEqual(
		{
			fetched: first.fetched,
			inserted: first.inserted,
			enriched: first.enriched,
			notified: first.notified,
		},
		{ fetched: 2, inserted: 2, enriched: 2, notified: 2 },
	);
	assert.equal(calls.length, 2);
	assert.deepEqual(store.list()[0].tags, ["react"]);

	const second = await runPipeline(deps);
	assert.equal(second.inserted, 0);
	assert.equal(calls.length, 2, "aucun appel LLM pour des articles déjà connus");
	assert.equal(notified.length, 1);
	assert.equal(store.runs().length, 2);
});

test("pipeline : un article stocké avec son URL brute (v1) n'est pas réinséré", async () => {
	const store = new Store(":memory:");
	store.insertPending({
		title: "Ancien",
		url: "https://a.test/1?utm_source=rss#top",
		source: "x",
		content: "",
		published_at: null,
	});
	const result = await runPipeline(pipelineDeps(store, { fetchFeed: fakeFeed(ITEMS) }));
	assert.equal(result.inserted, 1);
});

test("pipeline : réponse inexploitable → échec retenté 3 fois ; score faible → pas de notification", async () => {
	const store = new Store(":memory:");
	let reply = "désolé, pas de JSON";
	const { llm, calls } = fakeLlm(() => reply);
	const notified: Article[] = [];
	const deps = pipelineDeps(store, {
		fetchFeed: fakeFeed([ITEMS[1]]),
		llm,
		notify: async (a) => void notified.push(...a),
	});

	for (let i = 0; i < 4; i++) await runPipeline(deps);
	assert.equal(calls.length, 3, "abandon après 3 tentatives");
	assert.equal(store.stats().failed, 1);

	store.db.exec("UPDATE articles SET attempts = 0");
	reply = goodReply(2);
	await runPipeline(deps);
	assert.equal(store.stats().total, 1);
	assert.equal(notified.length, 0);
});

test("pipeline : panne du fournisseur → on s'arrête sans pénaliser les articles", async () => {
	const store = new Store(":memory:");
	const { llm, calls } = fakeLlm(() => {
		throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
	});
	const result = await runPipeline(pipelineDeps(store, { fetchFeed: fakeFeed(ITEMS), llm }));
	assert.equal(calls.length, 1);
	assert.equal(result.failed, 0);
	assert.equal(store.stats().pending, 2);
	assert.equal(store.enrichmentQueue(10)[0].attempts, 0);
});

test("pipeline : sans LLM les articles restent en file", async () => {
	const store = new Store(":memory:");
	const result = await runPipeline(pipelineDeps(store, { fetchFeed: fakeFeed(ITEMS) }));
	assert.equal(result.inserted, 2);
	assert.equal(store.stats().pending, 2);
});

test("enrichissement : JSON toléré dans du texte, score borné, tags filtrés", () => {
	const raw =
		'```json\n{"summary":"Un résumé assez long pour passer la validation.","score":"9","tags":["React","Sécurité","inconnu","react"]}\n```';
	assert.deepEqual(parseEnrichment(raw), {
		summary: "Un résumé assez long pour passer la validation.",
		score: 5,
		tags: ["react", "securite"],
		duplicateOf: null,
	});
	const withDuplicate =
		'{"summary":"Un résumé assez long pour passer la validation.","score":4,"duplicate_of":"12"}';
	assert.equal(parseEnrichment(withDuplicate, [12, 15]).duplicateOf, 12);
	assert.equal(
		parseEnrichment(withDuplicate, [15]).duplicateOf,
		null,
		"numéro hors candidats ignoré",
	);
	assert.equal(parseEnrichment(withDuplicate).duplicateOf, null);
	assert.throws(() => parseEnrichment('{"summary":"court","score":3}'));
	assert.throws(() => parseEnrichment("rien"));
});

test("LLM : retry sur 429 et erreurs réseau, pas sur 401", async () => {
	let n = 0;
	const flaky = withRetry(
		async () => {
			n++;
			if (n === 1) throw Object.assign(new Error("rate"), { statusCode: 429 });
			if (n === 2) throw new Error("ECONNRESET");
			return "ok";
		},
		{ baseDelayMs: 1 },
	);
	assert.equal(await flaky.complete("x"), "ok");
	assert.equal(n, 3);

	let m = 0;
	const denied = withRetry(
		async () => {
			m++;
			throw Object.assign(new Error("no"), { statusCode: 401 });
		},
		{ baseDelayMs: 1 },
	);
	await assert.rejects(denied.complete("x"));
	assert.equal(m, 1);
});

test("planificateur : plage horaire et lundi en heure de Paris", () => {
	const hours = { start: 9, end: 19 };
	assert.equal(isActiveHour(new Date("2026-06-15T07:30:00Z"), hours, "Europe/Paris"), true); // 9h30
	assert.equal(isActiveHour(new Date("2026-06-15T17:30:00Z"), hours, "Europe/Paris"), false); // 19h30
	assert.equal(isActiveHour(new Date("2026-01-15T08:30:00Z"), hours, "Europe/Paris"), true); // 9h30 hiver
	assert.equal(
		isActiveHour(new Date("2026-06-15T22:30:00Z"), { start: 22, end: 6 }, "Europe/Paris"),
		true,
	);
	assert.equal(mondayKey(new Date("2026-06-14T22:30:00Z"), "Europe/Paris"), "2026-06-15");
	assert.equal(mondayKey(new Date("2026-06-16T10:00:00Z"), "Europe/Paris"), null);
});

test("pipeline : doublons de sujet regroupés, source lue depuis la base, tokens comptés", async () => {
	const store = new Store(":memory:");
	for (const s of store.sources()) store.deleteSource(s.id);
	store.addSource({ name: "Blog A", url: "https://a.test/rss" });
	store.addSource({ name: "Blog B", url: "https://b.test/rss" });
	store.addSource({ name: "Cassée", url: "https://ko.test/rss" });
	store.addSource({ name: "Désactivée", url: "https://off.test/rss", status: "disabled" });

	const fetched: string[] = [];
	const feeds: Record<string, FeedItem[]> = {
		"https://a.test/rss": [{ title: "React 20 est disponible", link: "https://a.test/react-20" }],
		"https://b.test/rss": [],
	};
	const fetchFeed: FeedFetcher = async (url) => {
		fetched.push(url);
		if (!(url in feeds)) throw new Error("timeout");
		return { items: feeds[url] };
	};
	// Faux LLM : signale comme doublon le premier candidat proposé, et déclare sa consommation.
	const prompts: string[] = [];
	const llm: Llm = {
		async complete(prompt) {
			prompts.push(prompt);
			store.addUsage("enrich", 1000, 100);
			const candidate = prompt.match(/^\[(\d+)\] /m)?.[1] ?? null;
			return JSON.stringify({
				summary: "Un résumé suffisamment long pour être accepté par la validation.",
				score: 5,
				tags: ["react"],
				duplicate_of: candidate ? Number(candidate) : null,
			});
		},
	};
	const notified: Article[] = [];
	const deps = pipelineDeps(store, {
		sources: undefined,
		fetchFeed,
		llm,
		notify: async (a) => void notified.push(...a),
	});

	const first = await runPipeline(deps);
	assert.deepEqual(fetched.sort(), [
		"https://a.test/rss",
		"https://b.test/rss",
		"https://ko.test/rss",
	]);
	assert.deepEqual(first.sources_failed, ["Cassée"]);
	assert.equal(first.duplicates, 0);
	assert.equal(first.prompt_tokens, 1000);
	assert.doesNotMatch(prompts[0], /duplicate_of/, "aucun candidat : le prompt n'en parle pas");

	const health = Object.fromEntries(store.sources().map((s) => [s.name, s]));
	assert.equal(health["Blog A"].failures, 0);
	assert.equal(health["Blog A"].last_item_count, 1);
	assert.equal(health.Cassée.failures, 1);
	assert.equal(health.Cassée.last_error, "timeout");
	assert.equal(health.Désactivée.last_success_at, null);

	// Une autre source publie la même annonce.
	feeds["https://b.test/rss"] = [{ title: "Sortie de React 20", link: "https://b.test/react-20" }];
	const second = await runPipeline(deps);
	assert.equal(second.enriched, 1);
	assert.equal(second.duplicates, 1);
	assert.match(prompts[1], /\[\d+\] React 20 est disponible \(Blog A\)/);

	const listed = store.list();
	assert.equal(listed.length, 1, "le doublon n'apparaît plus dans la liste");
	assert.equal(listed[0].coverage, 2);
	assert.deepEqual(listed[0].also_in, ["Blog B"]);
	assert.equal(store.clusterMembers(listed[0].id)[0].source, "Blog B");
	assert.equal(
		store.search("sortie")[0].id,
		listed[0].id,
		"la recherche ramène à l'article principal",
	);
	assert.equal(notified.length, 1, "le doublon n'est pas notifié");
	assert.equal(store.runs(1)[0].duplicates, 1);
	assert.equal(store.usageTotals("month", "enrich").calls, 2);
});
