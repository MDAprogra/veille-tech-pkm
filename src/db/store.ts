import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { migrate } from "./migrations.js";

export const MAX_ATTEMPTS = 3;

export type ArticleStatus = "pending" | "done" | "failed";

export interface Article {
	id: number;
	title: string;
	url: string;
	source: string;
	summary: string | null;
	content: string;
	published_at: string | null;
	score: number;
	tags: string[];
	status: ArticleStatus;
	attempts: number;
	created_at: string;
	notified_at: string | null;
}

export interface NewArticle {
	title: string;
	url: string;
	source: string;
	content: string;
	published_at: string | null;
}

export interface Filters {
	minScore?: number;
	tag?: string;
	source?: string;
	/** Articles collectés durant les N derniers jours. */
	days?: number;
	limit?: number;
	offset?: number;
}

export interface Run {
	id: number;
	started_at: string;
	finished_at: string | null;
	fetched: number;
	inserted: number;
	enriched: number;
	failed: number;
	notified: number;
	sources_failed: string[];
	error: string | null;
}

export type RunResult = Pick<
	Run,
	"fetched" | "inserted" | "enriched" | "failed" | "notified" | "sources_failed" | "error"
>;

type Row = Omit<Article, "tags"> & { tags: string };
type RunRow = Omit<Run, "sources_failed"> & { sources_failed: string };

const STOPWORDS = new Set(
	`a au aux avec ce ces cette comme dans de des du elle en est et il ils je la le les leur mais
	 ne nous on ou où par pas pour qu que quel quelle quelles quels qui quoi sa se ses son sur ta te
	 tes ton tu un une vous y ça c d j l m n s t sont fait faire peut plus moins très tout tous
	 comment pourquoi quand est-ce the an and are as at be by for from how in is it of on or that
	 this to was what when where which who why with about into does do can`.split(/\s+/),
);

/** Transforme une question libre en requête FTS5 (mots-clés en OR, préfixes autorisés). */
export function toFtsQuery(text: string): string | null {
	const tokens = text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((t) => t.length >= 2 && !STOPWORDS.has(t));
	const unique = [...new Set(tokens)].slice(0, 12);
	if (unique.length === 0) return null;
	return unique.map((t) => `"${t}"*`).join(" OR ");
}

export class Store {
	readonly db: Database.Database;

	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.db = new Database(path);
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("busy_timeout = 5000");
		migrate(this.db);
	}

	close(): void {
		this.db.close();
	}

	// ── Écriture (pipeline) ────────────────────────────────────────────────

	knownUrls(urls: string[]): Set<string> {
		const known = new Set<string>();
		const stmt = this.db.prepare("SELECT 1 FROM articles WHERE url = ?");
		for (const url of urls) if (stmt.get(url)) known.add(url);
		return known;
	}

	/** Insère un article en attente d'enrichissement. Retourne false si l'URL existe déjà. */
	insertPending(article: NewArticle): boolean {
		const result = this.db
			.prepare(
				`INSERT OR IGNORE INTO articles (title, url, source, content, published_at, status, score)
				 VALUES (@title, @url, @source, @content, @published_at, 'pending', 0)`,
			)
			.run(article);
		return result.changes > 0;
	}

	/** Articles à enrichir : nouveaux d'abord, puis échecs n'ayant pas épuisé leurs tentatives. */
	enrichmentQueue(limit: number): Article[] {
		return this.rows(
			`SELECT * FROM articles
			 WHERE status = 'pending' OR (status = 'failed' AND attempts < ?)
			 ORDER BY status = 'pending' DESC, created_at DESC, id DESC
			 LIMIT ?`,
			MAX_ATTEMPTS,
			limit,
		);
	}

	markEnriched(id: number, data: { summary: string; score: number; tags: string[] }): void {
		this.db
			.prepare(
				`UPDATE articles SET summary = ?, score = ?, tags = ?, status = 'done', attempts = attempts + 1
				 WHERE id = ?`,
			)
			.run(data.summary, data.score, JSON.stringify(data.tags), id);
	}

	markFailed(id: number): void {
		this.db
			.prepare("UPDATE articles SET status = 'failed', attempts = attempts + 1 WHERE id = ?")
			.run(id);
	}

	/** Articles pertinents jamais notifiés (limités aux 2 derniers jours pour éviter les rafales). */
	pendingNotifications(minScore: number): Article[] {
		return this.rows(
			`SELECT * FROM articles
			 WHERE status = 'done' AND notified_at IS NULL AND score >= ?
			   AND created_at >= datetime('now', '-2 days')
			 ORDER BY score DESC, created_at DESC`,
			minScore,
		);
	}

	markNotified(ids: number[]): void {
		const stmt = this.db.prepare("UPDATE articles SET notified_at = datetime('now') WHERE id = ?");
		this.db.transaction(() => {
			for (const id of ids) stmt.run(id);
		})();
	}

	/** Remet en file les articles sans tags ou sans score (historique de la v1). */
	requeueIncomplete(): number {
		return this.db
			.prepare(
				`UPDATE articles SET status = 'pending', attempts = 0
				 WHERE status = 'done' AND (tags = '[]' OR score = 0)`,
			)
			.run().changes;
	}

	// ── Lecture ────────────────────────────────────────────────────────────

	get(id: number): Article | undefined {
		return this.rows("SELECT * FROM articles WHERE id = ?", id)[0];
	}

	/** Articles enrichis, du plus récent au plus ancien. */
	list(filters: Filters = {}): Article[] {
		const { where, params } = this.where(filters);
		const paging = filters.limit ? "LIMIT ? OFFSET ?" : "";
		const pagingParams = filters.limit ? [filters.limit, filters.offset ?? 0] : [];
		return this.rows(
			`SELECT a.* FROM articles a WHERE ${where} ORDER BY a.created_at DESC, a.id DESC ${paging}`,
			...params,
			...pagingParams,
		);
	}

	/** Meilleurs articles (score puis date). */
	top(filters: Filters = {}): Article[] {
		const { where, params } = this.where(filters);
		return this.rows(
			`SELECT a.* FROM articles a WHERE ${where}
			 ORDER BY a.score DESC, a.created_at DESC, a.id DESC LIMIT ?`,
			...params,
			filters.limit ?? 10,
		);
	}

	/** Recherche plein texte (FTS5, classement BM25 : titre > résumé > contenu). */
	search(query: string, filters: Filters = {}): Article[] {
		const fts = toFtsQuery(query);
		if (!fts) return [];
		const { where, params } = this.where(filters);
		return this.rows(
			`SELECT a.* FROM articles_fts f JOIN articles a ON a.id = f.rowid
			 WHERE articles_fts MATCH ? AND ${where}
			 ORDER BY bm25(articles_fts, 8.0, 4.0, 1.0), a.created_at DESC
			 LIMIT ?`,
			fts,
			...params,
			filters.limit ?? 5,
		);
	}

	stats() {
		const one = <T>(sql: string) => this.db.prepare(sql).get() as T;
		const pairs = (sql: string) =>
			Object.fromEntries(
				(this.db.prepare(sql).all() as Array<{ k: string | number; n: number }>).map((r) => [
					r.k,
					r.n,
				]),
			);
		const counts = one<{ total: number; pending: number; failed: number; avg: number | null }>(
			`SELECT
				COALESCE(SUM(status = 'done'), 0) AS total,
				COALESCE(SUM(status = 'pending'), 0) AS pending,
				COALESCE(SUM(status = 'failed'), 0) AS failed,
				AVG(CASE WHEN status = 'done' AND score > 0 THEN score END) AS avg
			 FROM articles`,
		);
		return {
			total: counts.total,
			pending: counts.pending,
			failed: counts.failed,
			averageScore: counts.avg === null ? null : Math.round(counts.avg * 100) / 100,
			lastArticle: this.list({ limit: 1 })[0] ?? null,
			bySource: pairs(
				`SELECT source AS k, COUNT(*) AS n FROM articles WHERE status = 'done'
				 GROUP BY source ORDER BY n DESC`,
			) as Record<string, number>,
			scoreDistribution: pairs(
				`SELECT score AS k, COUNT(*) AS n FROM articles WHERE status = 'done'
				 GROUP BY score ORDER BY score`,
			) as Record<string, number>,
			byTag: pairs(
				`SELECT j.value AS k, COUNT(*) AS n FROM articles a, json_each(a.tags) j
				 WHERE a.status = 'done' GROUP BY j.value ORDER BY n DESC`,
			) as Record<string, number>,
			byWeek: pairs(
				`SELECT date(created_at, 'weekday 0', '-6 days') AS k, COUNT(*) AS n FROM articles
				 WHERE status = 'done' GROUP BY k ORDER BY k DESC LIMIT 26`,
			) as Record<string, number>,
		};
	}

	// ── Historique des collectes ───────────────────────────────────────────

	startRun(): number {
		return Number(this.db.prepare("INSERT INTO runs DEFAULT VALUES").run().lastInsertRowid);
	}

	finishRun(id: number, result: RunResult): void {
		this.db
			.prepare(
				`UPDATE runs SET finished_at = datetime('now'), fetched = @fetched, inserted = @inserted,
				 enriched = @enriched, failed = @failed, notified = @notified,
				 sources_failed = @sources_failed, error = @error WHERE id = @id`,
			)
			.run({ ...result, sources_failed: JSON.stringify(result.sources_failed), id });
	}

	runs(limit = 10): Run[] {
		const rows = this.db
			.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT ?")
			.all(limit) as RunRow[];
		return rows.map((r) => ({ ...r, sources_failed: safeJsonArray(r.sources_failed) }));
	}

	runCount(): number {
		return (this.db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;
	}

	getMeta(key: string): string | undefined {
		const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
			| { value: string }
			| undefined;
		return row?.value;
	}

	setMeta(key: string, value: string): void {
		this.db
			.prepare(
				"INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			)
			.run(key, value);
	}

	// ── Interne ────────────────────────────────────────────────────────────

	private where(filters: Filters): { where: string; params: unknown[] } {
		const clauses = ["a.status = 'done'"];
		const params: unknown[] = [];
		if (filters.minScore) {
			clauses.push("a.score >= ?");
			params.push(filters.minScore);
		}
		if (filters.tag) {
			clauses.push("EXISTS (SELECT 1 FROM json_each(a.tags) WHERE value = ?)");
			params.push(filters.tag.toLowerCase());
		}
		if (filters.source) {
			clauses.push("a.source = ?");
			params.push(filters.source);
		}
		if (filters.days) {
			clauses.push("a.created_at >= datetime('now', ?)");
			params.push(`-${Math.floor(filters.days)} days`);
		}
		return { where: clauses.join(" AND "), params };
	}

	private rows(sql: string, ...params: unknown[]): Article[] {
		const rows = this.db.prepare(sql).all(...params) as Row[];
		return rows.map((r) => ({ ...r, tags: safeJsonArray(r.tags) }));
	}
}

function safeJsonArray(value: string): string[] {
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
	} catch {
		return [];
	}
}
