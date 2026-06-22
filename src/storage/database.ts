import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { config } from "../config/index.js";

mkdirSync(dirname(config.db.path), { recursive: true });

const db = new Database(config.db.path);

export interface StoredArticle {
	id: number;
	title: string;
	url: string;
	source: string;
	summary: string;
	content: string;
	published_at: string;
	score: number;
	created_at: string;
}
export type EnrichedArticle = Omit<StoredArticle, "id" | "created_at">;

export function initDB() {
	db.exec(`
    CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      url TEXT UNIQUE NOT NULL,
      source TEXT,
      summary TEXT,
      content TEXT,
      published_at TEXT,
      score INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

	try {
		db.exec(`ALTER TABLE articles ADD COLUMN score INTEGER DEFAULT 0`);
	} catch {
		// Colonne déjà existante — on ignore
	}
}

export function insertArticle(article: {
	title: string;
	url: string;
	source: string;
	summary: string;
	content: string;
	published_at: string;
	score: number;
}) {
	const stmt = db.prepare(`
    INSERT OR IGNORE INTO articles (title, url, source, summary, content, published_at, score)
    VALUES (@title, @url, @source, @summary, @content, @published_at, @score)
  `);
	return stmt.run(article);
}

export function getRecentArticles(limit = 10): StoredArticle[] {
	return db
		.prepare(`SELECT * FROM articles ORDER BY created_at DESC LIMIT ?`)
		.all(limit) as StoredArticle[];
}

export function searchArticles(query: string, limit = 5): StoredArticle[] {
	return db
		.prepare(`
    SELECT * FROM articles 
    WHERE title LIKE ? OR summary LIKE ? OR content LIKE ?
    ORDER BY created_at DESC 
    LIMIT ?
  `)
		.all(`%${query}%`, `%${query}%`, `%${query}%`, limit) as StoredArticle[];
}

export function exportAllArticles(): StoredArticle[] {
	return db
		.prepare(`
    SELECT * FROM articles 
    WHERE summary != 'Résumé indisponible.'
    ORDER BY created_at DESC
  `)
		.all() as StoredArticle[];
}

export { db };
