import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import type { App } from "../src/app.js";
import { Store } from "../src/db/store.js";
import { createHttpApp } from "../src/interfaces/http.js";
import { articleHtml } from "../src/interfaces/telegram.js";
import { withRetry } from "../src/llm/mistral.js";
import type { FeedFetcher } from "../src/pipeline/collect.js";
import { cost, usageSummary } from "../src/services/cost.js";
import { exportCsv } from "../src/services/format.js";
import { trends } from "../src/services/report.js";
import {
	assertPublicUrl,
	discoverFeeds,
	resolveFeed,
	SourceError,
} from "../src/services/sources.js";
import { SOURCES } from "../src/sources.js";
import { fakeLlm, seed, testApp } from "./helpers.js";

const servers: Array<{ close(): void }> = [];
after(() => {
	for (const s of servers) s.close();
});

// biome-ignore lint/suspicious/noExplicitAny: réponses JSON de test
type Reply = { status: number; body: any; total: string | null };

async function serve(app: App) {
	const server = createHttpApp(app).listen(0);
	servers.push(server);
	await new Promise((resolve) => server.once("listening", resolve));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
	return async (path: string, method = "GET", body?: unknown): Promise<Reply> => {
		const res = await fetch(base + path, {
			method,
			headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await res.text();
		return {
			status: res.status,
			body: text ? JSON.parse(text) : null,
			total: res.headers.get("X-Total-Count"),
		};
	};
}

const recentItems = (n: number, prefix = "Article") =>
	Array.from({ length: n }, (_, i) => ({
		title: `${prefix} ${i + 1}`,
		link: `https://x.test/${prefix}-${i}`,
		isoDate: new Date().toISOString(),
	}));

test("base v3 : sources initiales, actions de lecture, groupes, consommation, rapports", () => {
	const store = new Store(":memory:");
	assert.equal(store.sources("active").length, SOURCES.length);
	assert.equal(store.activeSources()[0].url.startsWith("https://"), true);
	assert.equal(store.addSource({ name: "Doublon", url: SOURCES[0].url }), undefined);

	const a = seed(store, {
		title: "Vite 8 est sorti",
		url: "https://a.test/1",
		tags: ["outils"],
		source: "A",
	});
	const b = seed(store, {
		title: "Sortie de Vite 8",
		url: "https://b.test/1",
		tags: ["outils"],
		source: "B",
	});
	const c = seed(store, { title: "Vite 8 : les nouveautés", url: "https://c.test/1", source: "C" });
	const other = seed(store, {
		title: "Guide Vite pour débutants",
		url: "https://d.test/1",
		tags: ["outils"],
		source: "D",
	});

	assert.deepEqual(
		store
			.similarRecent({ id: b, title: "Sortie de Vite 8", source: "B" })
			.map((x) => x.id)
			.sort(),
		[a, c, other].sort(),
	);
	assert.equal(
		store.markEnriched(b, { summary: "Résumé.", score: 4, tags: [], duplicateOf: a }),
		true,
	);
	// c est rattaché à b, lui-même rattaché à a : c rejoint directement a.
	assert.equal(
		store.markEnriched(c, { summary: "Résumé.", score: 4, tags: [], duplicateOf: b }),
		true,
	);
	assert.equal(
		store.markEnriched(a, { summary: "Résumé.", score: 4, tags: ["outils"], duplicateOf: a }),
		false,
		"pas de rattachement à soi-même",
	);
	assert.equal(store.get(a)?.coverage, 3);
	assert.deepEqual(store.get(a)?.also_in.sort(), ["B", "C"]);
	assert.equal(store.get(c)?.cluster_id, a);
	assert.equal(store.count(), 2);
	assert.equal(store.count({ includeClustered: true }), 4);
	assert.deepEqual(
		store.related(store.get(a) as never).map((x) => x.id),
		[other],
	);
	assert.match(articleHtml(store.get(a) as never), /Couvert par 3 sources \(aussi : B, C\)/);
	assert.match(exportCsv(store.list()), /,coverage,favorite\n/);

	store.updateArticle(a, { favorite: true, read: true });
	assert.equal(store.get(a)?.favorite, true);
	assert.notEqual(store.get(a)?.read_at, null);
	assert.deepEqual(
		store.list({ favorite: true }).map((x) => x.id),
		[a],
	);
	assert.deepEqual(
		store.list({ unread: true }).map((x) => x.id),
		[other],
	);
	store.updateArticle(a, { read: false, dismissed: true });
	assert.equal(store.get(a)?.read_at, null);
	assert.equal(store.get(b)?.dismissed, true, "« pas pertinent » s'applique à tout le groupe");
	assert.deepEqual(
		store.list().map((x) => x.id),
		[other],
	);
	assert.equal(store.list({ includeDismissed: true }).length, 2);

	store.addUsage("enrich", 1_000_000, 100_000);
	store.addUsage("enrich", 500_000, 0);
	store.addUsage("ask", 2000, 500);
	assert.deepEqual(store.usageTotals("month", "enrich"), {
		calls: 2,
		prompt_tokens: 1_500_000,
		completion_tokens: 100_000,
	});
	assert.equal(
		cost({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }, { input: 0.17, output: 0.66 }),
		0.83,
	);
	const usage = usageSummary(store, { input: 0.2, output: 1 });
	assert.equal(usage.month.calls, 3);
	assert.equal(usage.byPurpose[0].purpose, "enrich");
	assert.equal(usage.byPurpose[0].cost, 0.4);
	assert.equal(usage.byDay.length, 1);

	const report = store.addReport({ days: 7, articles: 4, content: "# Rapport" });
	assert.equal(store.reports()[0].id, report.id);
	assert.equal(store.report(report.id)?.content, "# Rapport");
	assert.equal(store.deleteReport(report.id), true);

	const t = trends(store, 4);
	assert.equal(t.weeks.length, 4);
	assert.deepEqual(t.total, [0, 0, 0, 4]);
	assert.deepEqual(t.series.outils, [0, 0, 0, 2]);
});

test("LLM : la consommation est transmise avec l'usage de l'appel", async () => {
	const seen: unknown[] = [];
	const llm = withRetry(
		async () => ({ text: "ok", usage: { promptTokens: 12, completionTokens: 3 } }),
		{
			onUsage: (purpose, usage) => seen.push([purpose, usage]),
		},
	);
	assert.equal(await llm.complete("x", { purpose: "ask" }), "ok");
	assert.equal(await llm.complete("x"), "ok");
	assert.deepEqual(seen, [
		["ask", { promptTokens: 12, completionTokens: 3 }],
		["other", { promptTokens: 12, completionTokens: 3 }],
	]);
});

test("sources : adresses internes refusées, flux découvert depuis une page web", async () => {
	for (const url of [
		"http://localhost/rss",
		"http://127.0.0.1/x",
		"http://10.0.0.5/x",
		"http://192.168.1.1/x",
		"http://169.254.169.254/latest",
		"http://[::1]/x",
		"ftp://a.test/x",
		"file:///etc/passwd",
		"n'importe quoi",
		"http://db.internal/x",
	]) {
		assert.throws(() => assertPublicUrl(url), SourceError, url);
	}
	assert.equal(assertPublicUrl(" https://blog.test/feed ").hostname, "blog.test");

	const html = `<head><link rel="stylesheet" href="/a.css">
		<link rel="alternate" type="application/rss+xml" title="RSS" href="/feed.xml?a=1&amp;b=2">
		<link href='https://blog.test/atom' type='application/atom+xml' rel='alternate'></head>`;
	assert.deepEqual(discoverFeeds(html, "https://blog.test/articles/"), [
		"https://blog.test/feed.xml?a=1&b=2",
		"https://blog.test/atom",
	]);

	const fetchFeed: FeedFetcher = async (url) => {
		if (url !== "https://blog.test/feed.xml?a=1&b=2") throw new Error("pas un flux");
		return { title: "Le Blog", items: recentItems(3) };
	};
	const feed = await resolveFeed("https://blog.test/articles/", {
		fetchFeed,
		fetchText: async () => html,
	});
	assert.equal(feed.url, "https://blog.test/feed.xml?a=1&b=2");
	await assert.rejects(
		resolveFeed("https://vide.test/", { fetchFeed, fetchText: async () => "<html></html>" }),
		/Aucun flux/,
	);
	await assert.rejects(
		resolveFeed("http://localhost:3000/", { fetchFeed, fetchText: async () => html }),
		SourceError,
	);
});

test("API : pagination, fiche, actions, tendances, système", async () => {
	const app = testApp();
	for (let i = 0; i < 7; i++)
		seed(app.store, {
			title: `Article React numéro ${i}`,
			url: `https://a.test/${i}`,
			tags: ["react"],
			score: 3 + (i % 3),
		});
	const call = await serve(app);

	const page1 = await call("/articles?limit=3");
	assert.equal(page1.total, "7");
	assert.equal(page1.body.length, 3);
	const page3 = await call("/articles?limit=3&offset=6");
	assert.equal(page3.body.length, 1);
	assert.notEqual(page3.body[0].id, page1.body[0].id);
	assert.equal((await call("/articles?min_score=5")).total, "2");

	const id = page1.body[0].id;
	const fiche = await call(`/articles/${id}`);
	assert.equal(fiche.body.article.id, id);
	assert.equal(fiche.body.related.length, 5);
	assert.deepEqual(fiche.body.coveredBy, []);
	assert.equal((await call("/articles/9999")).status, 404);
	assert.equal((await call("/articles/abc")).status, 404);

	assert.equal(
		(await call(`/articles/${id}`, "PATCH", { favorite: true, read: true })).body.favorite,
		true,
	);
	assert.equal((await call(`/articles/${id}`, "PATCH", { score: 5 })).status, 400);
	assert.equal((await call(`/articles/${id}`, "PATCH", { favorite: "oui" })).status, 400);
	assert.equal((await call("/articles?favorite=1")).total, "1");
	assert.equal((await call("/articles?unread=1")).total, "6");
	await call(`/articles/${id}`, "PATCH", { dismissed: true });
	assert.equal((await call("/articles")).total, "6");
	assert.equal((await call("/articles?dismissed=1")).total, "7");

	const stats = (await call("/stats")).body;
	assert.equal(stats.favorites, 0, "le favori vient d'être marqué « pas pertinent »");
	assert.equal(stats.sources, SOURCES.length);
	assert.equal(stats.usage.month.cost, 0);

	const t = (await call("/trends?weeks=8")).body;
	assert.equal(t.weeks.length, 8);
	assert.equal(t.series.react.at(-1), 7);

	const system = (await call("/system")).body;
	assert.equal(system.sources.length, SOURCES.length);
	assert.equal(system.features.mcpProtected, false);
	assert.equal(system.scheduler.intervalMinutes, 120);
	assert.ok(Array.isArray(system.events));
	assert.equal(system.llm, null);
	assert.equal(
		JSON.stringify(system).includes("secret"),
		false,
		"aucun jeton dans la page Système",
	);
	assert.equal((await call("/inconnu")).status, 404);
});

test("API : rapports générés, archivés, supprimés", async () => {
	const { llm, calls } = fakeLlm(() => "## Tendances\n- React domine");
	const app = testApp({}, { llm });
	const call = await serve(app);

	assert.equal((await call("/reports", "POST", { days: 7 })).status, 422, "aucun article");
	seed(app.store, { title: "React 20", url: "https://a.test/1", tags: ["react"] });
	assert.equal((await call("/reports", "POST", { days: -1 })).status, 400);

	const created = await call("/reports", "POST", { days: 7 });
	assert.equal(created.status, 201);
	assert.match(
		created.body.content,
		/^# Rapport de veille technologique — 7 derniers jours\n\n> Généré le .* à partir de 1 articles\.\n\n## Tendances/,
	);
	assert.equal(calls.length, 1);
	assert.equal((await call("/reports", "POST", {})).body.days, null);

	const list = (await call("/reports")).body;
	assert.equal(list.length, 2);
	assert.equal(list[0].content, undefined);
	assert.equal((await call(`/reports/${created.body.id}`)).body.articles, 1);
	assert.equal((await call(`/reports/${created.body.id}`, "DELETE")).status, 204);
	assert.equal((await call(`/reports/${created.body.id}`)).status, 404);

	const noLlm = await serve(testApp());
	assert.equal((await noLlm("/reports", "POST", { days: 7 })).status, 503);
});

test("API : gestion des sources et propositions vérifiées par l'IA", async () => {
	const feeds: Record<string, ReturnType<typeof recentItems>> = {
		"https://nouveau.test/rss": recentItems(5, "Nouveau"),
		"https://bon.test/feed": recentItems(6, "TypeScript"),
		"https://moyen.test/feed": recentItems(6, "Promo"),
		"https://vide.test/feed": recentItems(1),
		"https://mort.test/feed": recentItems(5).map((i) => ({
			...i,
			isoDate: "2020-01-01T00:00:00Z",
		})),
	};
	const fetchFeed: FeedFetcher = async (url) => {
		if (!(url in feeds)) throw new Error("404");
		return { title: `Titre de ${new URL(url).hostname}`, items: feeds[url] };
	};
	const prompts: string[] = [];
	const { llm } = fakeLlm((prompt) => {
		prompts.push(prompt);
		if (prompt.includes('"candidates"')) {
			return JSON.stringify({
				candidates: [
					{
						name: "Bon blog",
						url: "https://bon.test/feed",
						category: "web",
						lang: "fr",
						reason: "r",
					},
					{ name: "Blog moyen", url: "https://moyen.test/feed", category: "inconnue" },
					{ name: "Inventé", url: "https://invente.test/feed" },
					{ name: "Presque vide", url: "https://vide.test/feed" },
					{ name: "Abandonné", url: "https://mort.test/feed" },
					{ name: "Interne", url: "http://169.254.169.254/feed" },
					{ name: "Déjà suivi", url: "https://nouveau.test/rss" },
				],
			});
		}
		return JSON.stringify({
			reviews: [
				{ id: 1, score: 5, verdict: "Articles TypeScript de fond." },
				{ id: 2, score: 2, verdict: "Contenu promotionnel." },
			],
		});
	});
	const app = testApp({}, { llm, fetchFeed, fetchText: async () => "<html></html>" });
	const call = await serve(app);

	// Ajout manuel : flux vérifié, nom repris du flux, doublon refusé, adresse illisible refusée.
	const added = await call("/sources", "POST", { url: "https://nouveau.test/rss", category: "ia" });
	assert.equal(added.status, 201);
	assert.equal(added.body.name, "Titre de nouveau.test");
	assert.equal(added.body.category, "ia");
	assert.equal(added.body.origin, "user");
	assert.equal((await call("/sources", "POST", { url: "https://nouveau.test/rss" })).status, 422);
	const broken = await call("/sources", "POST", { url: "https://invente.test/feed" });
	assert.equal(broken.status, 422);
	assert.match(broken.body.error, /Aucun flux/);
	assert.equal(
		(await call("/sources", "POST", { url: "http://localhost/rss" })).body.error,
		"Adresse non autorisée",
	);
	assert.equal((await call("/sources", "POST", {})).status, 400);

	// Désactivation : la source n'est plus collectée.
	assert.equal(
		(await call(`/sources/${added.body.id}`, "PATCH", { status: "disabled" })).body.status,
		"disabled",
	);
	assert.equal(
		app.store.activeSources().some((s) => s.url === "https://nouveau.test/rss"),
		false,
	);
	assert.equal(
		(await call(`/sources/${added.body.id}`, "PATCH", { status: "suggested" })).status,
		400,
	);
	await call(`/sources/${added.body.id}`, "PATCH", { status: "active" });

	// Propositions : tâche de fond, suivie par interrogation.
	assert.equal((await call("/sources/suggest", "POST")).status, 202);
	let state = (await call("/sources")).body;
	for (let i = 0; i < 100 && state.suggestions.running; i++) {
		await new Promise((resolve) => setTimeout(resolve, 20));
		state = (await call("/sources")).body;
	}
	const report = state.suggestions.report;
	assert.equal(state.suggestions.error, null);
	assert.equal(report.proposed, 7);
	assert.deepEqual(
		report.added.map((a: { name: string }) => a.name),
		["Bon blog"],
	);
	const reasons = Object.fromEntries(
		report.discarded.map((d: { name: string; reason: string }) => [d.name, d.reason]),
	);
	assert.match(reasons["Blog moyen"], /peu pertinente \(2\/5\) : Contenu promotionnel/);
	assert.match(reasons.Inventé, /Aucun flux/);
	assert.equal(reasons["Presque vide"], "flux presque vide");
	assert.match(reasons.Abandonné, /inactif depuis \d+ jours/);
	assert.equal(reasons.Interne, "Adresse non autorisée");
	assert.equal(reasons["Déjà suivi"], "déjà connue");
	assert.match(
		prompts[0],
		/Titre de nouveau\.test : https:\/\/nouveau\.test\/rss/,
		"les sources connues sont transmises",
	);
	assert.match(
		prompts[1],
		/FLUX 1 — Bon blog[\s\S]*- TypeScript 1/,
		"l'IA juge sur les vrais titres",
	);

	// La proposition attend une validation humaine avant d'être collectée.
	const suggested = state.sources.find((s: { status: string }) => s.status === "suggested");
	assert.deepEqual(
		{
			name: suggested.name,
			ai_score: suggested.ai_score,
			note: suggested.note,
			origin: suggested.origin,
			lang: suggested.lang,
		},
		{
			name: "Bon blog",
			ai_score: 5,
			note: "Articles TypeScript de fond.",
			origin: "ai",
			lang: "fr",
		},
	);
	assert.equal(
		app.store.activeSources().some((s) => s.name === "Bon blog"),
		false,
	);
	assert.equal((await call("/stats")).body.suggestedSources, 1);
	await call(`/sources/${suggested.id}`, "PATCH", { status: "active" });
	assert.equal(
		app.store.activeSources().some((s) => s.name === "Bon blog"),
		true,
	);

	assert.equal((await call(`/sources/${suggested.id}`, "DELETE")).status, 204);
	assert.equal((await call(`/sources/${suggested.id}`, "DELETE")).status, 404);
	assert.equal((await (await serve(testApp()))("/sources/suggest", "POST")).status, 503);
});
