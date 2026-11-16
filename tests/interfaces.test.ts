import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import type { App } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createHttpApp } from "../src/interfaces/http.js";
import { articleHtml, escapeHtml, pack } from "../src/interfaces/telegram.js";
import { analyze } from "../src/services/analyze.js";
import { ask, formatAnswer } from "../src/services/ask.js";
import { chunk, exportCsv, exportMarkdown, weekOf } from "../src/services/format.js";
import { fakeLlm, seed, testApp } from "./helpers.js";

const servers: Array<{ close(): void }> = [];
after(() => {
	for (const s of servers) s.close();
});

async function serve(app: App): Promise<string> {
	const server = createHttpApp(app).listen(0);
	servers.push(server);
	await new Promise((resolve) => server.once("listening", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const auth = { Authorization: "Bearer secret" };

function populate(app: App) {
	seed(app.store, {
		title: "React Compiler en production",
		url: "https://a.test/1",
		score: 5,
		tags: ["react"],
		summary: 'Retour, d\'expérience "terrain".',
	});
	seed(app.store, {
		title: "Grilles CSS avancées",
		url: "https://a.test/2",
		score: 3,
		tags: ["css"],
	});
}

test("API : authentification, filtres, recherche, exports", async () => {
	const app = testApp();
	populate(app);
	const base = await serve(app);

	assert.equal((await fetch(`${base}/health`)).status, 200);
	assert.equal((await fetch(`${base}/api/articles`)).status, 401);
	assert.equal(
		(await fetch(`${base}/api/articles`, { headers: { Authorization: "Bearer faux" } })).status,
		401,
	);
	assert.match(await (await fetch(`${base}/`)).text(), /Tableau de bord/);

	// biome-ignore lint/suspicious/noExplicitAny: réponses JSON de test
	const get = async (path: string): Promise<any> =>
		(await fetch(`${base}/api${path}`, { headers: auth })).json();
	assert.equal((await get("/articles")).length, 2);
	assert.equal((await get("/articles?min_score=4"))[0].title, "React Compiler en production");
	assert.equal((await get("/articles?tag=css")).length, 1);
	assert.equal((await get("/articles?q=compiler")).length, 1);
	assert.equal((await get("/articles/recent?limit=1")).length, 1);
	assert.equal((await get("/articles/search?q=grilles"))[0].tags[0], "css");
	assert.equal((await fetch(`${base}/api/articles/search`, { headers: auth })).status, 400);
	const stats = await get("/stats");
	assert.equal(stats.total, 2);
	assert.equal(stats.lastArticle.title, "Grilles CSS avancées");
	assert.deepEqual(await get("/runs"), []);

	const csv = await (await fetch(`${base}/api/export.csv`, { headers: auth })).text();
	assert.match(csv, /"Retour, d'expérience ""terrain""\."/);
	assert.equal((await fetch(`${base}/api/collect`, { method: "POST", headers: auth })).status, 202);
	assert.equal((await fetch(`${base}/inconnu`)).status, 404);
});

test("API : sans DASHBOARD_TOKEN tout est refusé", async () => {
	const app = testApp();
	app.config = loadConfig({});
	const base = await serve(app);
	assert.equal(
		(await fetch(`${base}/api/stats`, { headers: { Authorization: "Bearer " } })).status,
		401,
	);
	assert.equal(
		(await fetch(`${base}/api/stats`, { headers: { Authorization: "Bearer undefined" } })).status,
		401,
	);
});

async function rpc(
	url: string,
	method: string,
	params: unknown,
	headers: Record<string, string> = {},
) {
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...headers,
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	const body = await res.text();
	const data = body.split("\n").find((l) => l.startsWith("data: "));
	return { status: res.status, json: res.ok ? JSON.parse(data ? data.slice(6) : body) : null };
}

test("MCP : liste des outils et appels", async () => {
	const app = testApp();
	populate(app);
	const url = `${await serve(app)}/mcp`;

	const tools = await rpc(url, "tools/list", {});
	assert.deepEqual(tools.json.result.tools.map((t: { name: string }) => t.name).sort(), [
		"export_all",
		"get_recent_articles",
		"get_stats",
		"get_timeline",
		"search_articles",
	]);

	const call = async (name: string, args: unknown) =>
		(await rpc(url, "tools/call", { name, arguments: args })).json.result.content[0].text as string;
	assert.match(
		await call("search_articles", { query: "react compiler" }),
		/React Compiler en production/,
	);
	assert.match(await call("search_articles", { query: "kubernetes" }), /Aucun article/);
	assert.match(await call("get_recent_articles", { limit: 1 }), /Grilles CSS/);
	assert.match(await call("get_stats", {}), /Articles résumés\*\* : 2/);
	assert.doesNotMatch(await call("export_all", { min_score: 4 }), /Grilles/);
	assert.match(await call("get_timeline", {}), /Semaine du .*\n\*2 articles\*/);
	assert.equal((await fetch(url)).status, 405);
});

test("MCP : MCP_TOKEN exigé en en-tête ou dans l'URL", async () => {
	const base = await serve(testApp({ MCP_TOKEN: "jeton-mcp" }));
	assert.equal((await rpc(`${base}/mcp`, "tools/list", {})).status, 401);
	assert.equal((await rpc(`${base}/mcp/mauvais`, "tools/list", {})).status, 401);
	assert.equal((await rpc(`${base}/mcp/jeton-mcp`, "tools/list", {})).status, 200);
	assert.equal(
		(await rpc(`${base}/mcp`, "tools/list", {}, { Authorization: "Bearer jeton-mcp" })).status,
		200,
	);
});

test("ask : contexte local cité, repli web seulement si la veille est mince", async () => {
	const app = testApp();
	populate(app);
	seed(app.store, { title: "React Server Components", url: "https://a.test/3", tags: ["react"] });
	const { llm, calls } = fakeLlm(() => "Réponse [1]");
	let webCalls = 0;
	const webSearch = async () => {
		webCalls++;
		return [{ title: "Web", url: "https://w.test", content: "contenu web" }];
	};

	const local = await ask("Quoi de neuf sur React ?", { store: app.store, llm, webSearch });
	assert.equal(local.articles.length, 2);
	assert.equal(webCalls, 0);
	assert.match(calls[0], /\[1\] React/);
	assert.match(formatAnswer(local), /Sources\n\[1\] .* — https:\/\/a\.test/);

	const remote = await ask("Kubernetes ?", { store: app.store, llm, webSearch });
	assert.equal(webCalls, 1);
	assert.match(calls[1], /\[W1\] Web/);
	assert.match(formatAnswer(remote), /\[W1\] Web — https:\/\/w\.test/);
});

test("analyze : null sans article, sinon rapport du LLM", async () => {
	const app = testApp();
	const { llm, calls } = fakeLlm(() => "Rapport");
	assert.equal(await analyze({ store: app.store, llm }), null);
	populate(app);
	assert.equal(await analyze({ store: app.store, llm }, { days: 7 }), "Rapport");
	assert.match(calls[0], /react \(1\)/);
});

test("mise en forme : exports, découpage, HTML Telegram", () => {
	const app = testApp();
	populate(app);
	const articles = app.store.list();
	const md = exportMarkdown(articles, new Date("2026-06-15T10:00:00Z"));
	assert.match(md, /^# Export Veille Technologique — 2026-06-15\n\n> 2 articles collectés/);
	assert.match(md, /- \*\*Thèmes\*\* : react/);
	assert.equal(exportCsv(articles).trim().split("\n").length, 3);

	assert.equal(weekOf("2026-06-21 23:00:00"), "2026-06-15");
	assert.equal(weekOf("2026-06-22 00:00:00"), "2026-06-22");

	const parts = chunk(`${"a".repeat(3000)}\n${"b".repeat(3000)}`, 4000);
	assert.deepEqual(
		parts.map((p) => p.length),
		[3000, 3000],
	);
	assert.equal(chunk("x".repeat(9000), 4000).join(""), "x".repeat(9000));
	assert.deepEqual(pack(["a".repeat(30), "b".repeat(30), "c"], 50).length, 2);

	assert.equal(escapeHtml("<b> & </b>"), "&lt;b&gt; &amp; &lt;/b&gt;");
	const html = articleHtml({ ...articles[0], title: "A <script> & B", summary: "x".repeat(700) });
	assert.match(html, /<b>A &lt;script&gt; &amp; B<\/b>/);
	assert.ok(html.includes(`${"x".repeat(600)}…`));
});

test("configuration : valeurs par défaut et erreurs explicites", () => {
	const config = loadConfig({});
	assert.equal(config.db.path, "./data/veille.db");
	assert.deepEqual(config.pipeline.activeHours, { start: 9, end: 19 });
	assert.equal(config.mistral.apiKey, undefined);
	assert.equal(
		loadConfig({ TELEGRAM_PUBLIC: "true", ACTIVE_HOURS: "8-20" }).pipeline.activeHours.end,
		20,
	);
	assert.throws(() => loadConfig({ PORT: "abc" }), /PORT/);
	assert.throws(() => loadConfig({ ACTIVE_HOURS: "matin" }), /ACTIVE_HOURS/);
});
