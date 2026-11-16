import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { Store, toFtsQuery } from "../src/db/store.js";
import { seed } from "./helpers.js";

test("migration : une base v1 est reprise sans perte ni rafale de notifications", () => {
	const path = join(mkdtempSync(join(tmpdir(), "veille-")), "veille.db");
	const legacy = new Database(path);
	legacy.exec(`
		CREATE TABLE articles (
			id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, url TEXT UNIQUE NOT NULL,
			source TEXT, summary TEXT, content TEXT, published_at TEXT,
			score INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
		);
		INSERT INTO articles (title, url, source, summary, content, published_at, score) VALUES
			('React 20 est sorti', 'https://a.test/1', 'Dev.to', 'Nouveautés du compilateur React.', 'contenu', 'Mon, 15 Jun 2026 08:00:00 GMT', 5),
			('Article raté', 'https://a.test/2', 'Korben', 'Résumé indisponible.', 'contenu brut', 'date invalide', 0);
	`);
	legacy.close();

	const store = new Store(path);
	const all = store.db.prepare("SELECT * FROM articles ORDER BY id").all() as Array<
		Record<string, unknown>
	>;
	assert.equal(all.length, 2);
	assert.equal(all[0].status, "done");
	assert.equal(all[0].published_at, "2026-06-15T08:00:00.000Z");
	assert.equal(all[1].status, "failed");
	assert.equal(all[1].summary, null);
	assert.equal(all[1].published_at, "date invalide");
	assert.ok(all.every((a) => a.notified_at !== null));

	assert.deepEqual(
		store.enrichmentQueue(10).map((a) => a.url),
		["https://a.test/2"],
	);
	assert.equal(store.pendingNotifications(1).length, 0);
	assert.equal(store.search("compilateur")[0]?.title, "React 20 est sorti");
	assert.equal(store.list().length, 1);
	store.close();

	// Réouverture : les migrations ne sont pas rejouées.
	const again = new Store(path);
	assert.equal(again.list().length, 1);
	again.close();
});

test("recherche plein texte : question libre, accents, préfixes, classement titre d'abord", () => {
	const store = new Store(":memory:");
	seed(store, {
		title: "Sécurité des API REST",
		url: "https://a.test/1",
		summary: "Bonnes pratiques OWASP.",
	});
	seed(store, {
		title: "Nouveautés CSS",
		url: "https://a.test/2",
		summary: "Un mot sur la securite des iframes.",
	});
	seed(store, { title: "Deno 3", url: "https://a.test/3", summary: "Runtime JavaScript." });

	const results = store.search("Quelles sont les bonnes pratiques de securite ?");
	assert.deepEqual(
		results.map((a) => a.title),
		["Sécurité des API REST", "Nouveautés CSS"],
	);
	assert.equal(store.search("javasc")[0]?.title, "Deno 3");
	assert.deepEqual(store.search("le la de ?"), []);
	assert.deepEqual(store.search('"; DROP TABLE articles; --'), []);
	assert.equal(toFtsQuery("Quoi de neuf sur React ?"), '"neuf"* OR "react"*');
});

test("filtres, statistiques et mise à jour de l'index après enrichissement", () => {
	const store = new Store(":memory:");
	seed(store, { title: "A", url: "https://a.test/1", score: 5, tags: ["react", "frontend"] });
	seed(store, { title: "B", url: "https://a.test/2", score: 2, tags: ["css"], source: "Autre" });
	store.insertPending({
		title: "En attente",
		url: "https://a.test/3",
		source: "Autre",
		content: "",
		published_at: null,
	});

	assert.deepEqual(
		store.list({ tag: "react" }).map((a) => a.title),
		["A"],
	);
	assert.deepEqual(
		store.list({ minScore: 3 }).map((a) => a.title),
		["A"],
	);
	assert.deepEqual(
		store.list({ source: "Autre" }).map((a) => a.title),
		["B"],
	);
	assert.equal(store.list({ days: 1 }).length, 2);
	assert.deepEqual(
		store.top({ limit: 1 }).map((a) => a.title),
		["A"],
	);
	assert.equal(store.search("résumé").length, 2);

	const stats = store.stats();
	assert.equal(stats.total, 2);
	assert.equal(stats.pending, 1);
	assert.equal(stats.averageScore, 3.5);
	assert.deepEqual(stats.byTag, { react: 1, frontend: 1, css: 1 });
	assert.deepEqual(stats.bySource, { "Flux test": 1, Autre: 1 });
	assert.deepEqual(stats.scoreDistribution, { 2: 1, 5: 1 });
	assert.equal(Object.values(stats.byWeek)[0], 2);

	assert.equal(store.requeueIncomplete(), 0);
	store.setMeta("k", "1");
	store.setMeta("k", "2");
	assert.equal(store.getMeta("k"), "2");
});
