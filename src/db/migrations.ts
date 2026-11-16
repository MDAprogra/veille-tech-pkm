import type { Database } from "better-sqlite3";

/**
 * Migrations versionnées via `PRAGMA user_version`.
 * Une base créée par la v1 de l'outil (user_version = 0, table `articles` déjà présente)
 * est reprise telle quelle : aucune donnée n'est supprimée.
 */
const MIGRATIONS: Array<(db: Database) => void> = [
	// v1 — schéma historique
	(db) => {
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
		if (!hasColumn(db, "articles", "score")) {
			db.exec("ALTER TABLE articles ADD COLUMN score INTEGER DEFAULT 0");
		}
	},

	// v2 — statut d'enrichissement, tags, notifications, recherche plein texte, historique des collectes
	(db) => {
		db.exec(`
			ALTER TABLE articles ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
			ALTER TABLE articles ADD COLUMN status TEXT NOT NULL DEFAULT 'done';
			ALTER TABLE articles ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE articles ADD COLUMN notified_at TEXT;

			-- Tout l'existant est considéré comme déjà notifié : pas de rafale au premier démarrage.
			UPDATE articles SET notified_at = created_at;

			-- Les résumés en échec de la v1 repassent dans la file d'enrichissement.
			UPDATE articles SET status = 'failed', summary = NULL, score = 0
			WHERE summary IS NULL OR summary = '' OR summary = 'Résumé indisponible.';

			CREATE INDEX idx_articles_created ON articles (created_at DESC);
			CREATE INDEX idx_articles_status ON articles (status);
			CREATE INDEX idx_articles_score ON articles (score);

			CREATE VIRTUAL TABLE articles_fts USING fts5(
				title, summary, content,
				content = 'articles', content_rowid = 'id',
				tokenize = 'unicode61 remove_diacritics 2'
			);
			CREATE TRIGGER articles_ai AFTER INSERT ON articles BEGIN
				INSERT INTO articles_fts (rowid, title, summary, content)
				VALUES (new.id, new.title, new.summary, new.content);
			END;
			CREATE TRIGGER articles_ad AFTER DELETE ON articles BEGIN
				INSERT INTO articles_fts (articles_fts, rowid, title, summary, content)
				VALUES ('delete', old.id, old.title, old.summary, old.content);
			END;
			CREATE TRIGGER articles_au AFTER UPDATE OF title, summary, content ON articles BEGIN
				INSERT INTO articles_fts (articles_fts, rowid, title, summary, content)
				VALUES ('delete', old.id, old.title, old.summary, old.content);
				INSERT INTO articles_fts (rowid, title, summary, content)
				VALUES (new.id, new.title, new.summary, new.content);
			END;
			INSERT INTO articles_fts (articles_fts) VALUES ('rebuild');

			CREATE TABLE runs (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				started_at TEXT NOT NULL DEFAULT (datetime('now')),
				finished_at TEXT,
				fetched INTEGER NOT NULL DEFAULT 0,
				inserted INTEGER NOT NULL DEFAULT 0,
				enriched INTEGER NOT NULL DEFAULT 0,
				failed INTEGER NOT NULL DEFAULT 0,
				notified INTEGER NOT NULL DEFAULT 0,
				sources_failed TEXT NOT NULL DEFAULT '[]',
				error TEXT
			);

			CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		`);

		// Les dates RSS (RFC 822) deviennent de l'ISO 8601, triable et comparable.
		const rows = db.prepare("SELECT id, published_at FROM articles").all() as Array<{
			id: number;
			published_at: string | null;
		}>;
		const update = db.prepare("UPDATE articles SET published_at = ? WHERE id = ?");
		for (const row of rows) {
			const iso = toIso(row.published_at);
			if (iso && iso !== row.published_at) update.run(iso, row.id);
		}
	},
];

export function migrate(db: Database): void {
	const current = db.pragma("user_version", { simple: true }) as number;
	for (let version = current; version < MIGRATIONS.length; version++) {
		db.transaction(() => {
			MIGRATIONS[version](db);
			db.pragma(`user_version = ${version + 1}`);
		})();
	}
}

function hasColumn(db: Database, table: string, column: string): boolean {
	const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
	return columns.some((c) => c.name === column);
}

export function toIso(value: string | null | undefined): string | null {
	if (!value) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
