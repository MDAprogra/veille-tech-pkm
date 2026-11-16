import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { Category, Source } from "../sources.js";
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
	/** Article principal du même sujet (null : cet article est le principal). */
	cluster_id: number | null;
	favorite: boolean;
	dismissed: boolean;
	read_at: string | null;
	/** Nombre de sources distinctes ayant couvert ce sujet (1 = lui seul). */
	coverage: number;
	/** Autres sources ayant couvert le même sujet. */
	also_in: string[];
}

export type SourceStatus = "active" | "disabled" | "suggested" | "rejected";

export interface SourceRow {
	id: number;
	name: string;
	url: string;
	category: Category;
	lang: "fr" | "en";
	status: SourceStatus;
	origin: "builtin" | "user" | "ai";
	note: string | null;
	ai_score: number | null;
	created_at: string;
	last_success_at: string | null;
	last_item_count: number | null;
	last_error: string | null;
	last_error_at: string | null;
	failures: number;
}

export interface Report {
	id: number;
	created_at: string;
	days: number | null;
	articles: number;
	content: string;
}

export interface UsageTotals {
	calls: number;
	prompt_tokens: number;
	completion_tokens: number;
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
	favorite?: boolean;
	unread?: boolean;
	/** Inclure les articles marqués « pas pertinent » (exclus par défaut). */
	includeDismissed?: boolean;
	/** Inclure les doublons de sujet rattachés à un article principal (exclus par défaut). */
	includeClustered?: boolean;
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
	duplicates: number;
	prompt_tokens: number;
	completion_tokens: number;
}

export type RunResult = Pick<
	Run,
	| "fetched"
	| "inserted"
	| "enriched"
	| "failed"
	| "notified"
	| "sources_failed"
	| "error"
	| "duplicates"
	| "prompt_tokens"
	| "completion_tokens"
>;

type Row = Omit<Article, "tags" | "also_in" | "favorite" | "dismissed"> & {
	tags: string;
	also_in: string | null;
	favorite: number;
	dismissed: number;
};

/** Sélection d'articles avec la couverture du sujet par les autres sources. */
const SELECT = `SELECT a.*,
	1 + (SELECT COUNT(DISTINCT m.source) FROM articles m
	     WHERE m.cluster_id = a.id AND m.source <> a.source) AS coverage,
	(SELECT json_group_array(DISTINCT m.source) FROM articles m
	 WHERE m.cluster_id = a.id AND m.source <> a.source) AS also_in
	FROM articles a`;
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
			`${SELECT}
			 WHERE a.status = 'pending' OR (a.status = 'failed' AND a.attempts < ?)
			 ORDER BY a.status = 'pending' DESC, a.created_at DESC, a.id DESC
			 LIMIT ?`,
			MAX_ATTEMPTS,
			limit,
		);
	}

	/**
	 * Enregistre le résumé. Si `duplicateOf` désigne un article couvrant le même sujet,
	 * l'article lui est rattaché : il n'apparaît plus dans les listes et n'est pas notifié.
	 * Retourne true si l'article a été rattaché.
	 */
	markEnriched(
		id: number,
		data: { summary: string; score: number; tags: string[]; duplicateOf?: number | null },
	): boolean {
		this.db
			.prepare(
				`UPDATE articles SET summary = ?, score = ?, tags = ?, status = 'done', attempts = attempts + 1
				 WHERE id = ?`,
			)
			.run(data.summary, data.score, JSON.stringify(data.tags), id);
		if (!data.duplicateOf) return false;
		const target = this.db
			.prepare(
				"SELECT COALESCE(cluster_id, id) AS root FROM articles WHERE id = ? AND status = 'done'",
			)
			.get(data.duplicateOf) as { root: number } | undefined;
		if (!target || target.root === id) return false;
		// Un article déjà principal d'un groupe emmène ses membres avec lui.
		this.db
			.prepare(
				`UPDATE articles SET cluster_id = ?, notified_at = COALESCE(notified_at, datetime('now'))
				 WHERE id = ? OR cluster_id = ?`,
			)
			.run(target.root, id, id);
		return true;
	}

	/**
	 * Candidats doublons : articles récents d'autres sources dont le titre ou le résumé
	 * ressemble au titre donné. Chaque candidat est ramené à l'article principal de son groupe.
	 */
	similarRecent(
		article: { id: number; title: string; source: string },
		{ days = 5, limit = 5 } = {},
	): Array<{ id: number; title: string; source: string }> {
		const fts = toFtsQuery(article.title);
		if (!fts) return [];
		const rows = this.db
			.prepare(
				`SELECT COALESCE(a.cluster_id, a.id) AS root
				 FROM articles_fts f JOIN articles a ON a.id = f.rowid
				 WHERE articles_fts MATCH ? AND a.status = 'done' AND a.id <> ? AND a.source <> ?
				   AND a.created_at >= datetime('now', ?)
				 ORDER BY bm25(articles_fts, 8.0, 4.0, 0.0) LIMIT ?`,
			)
			.all(fts, article.id, article.source, `-${days} days`, limit * 3) as Array<{ root: number }>;
		const roots = [...new Set(rows.map((r) => r.root))].filter((r) => r !== article.id);
		const get = this.db.prepare("SELECT id, title, source FROM articles WHERE id = ?");
		return roots
			.slice(0, limit)
			.map((root) => get.get(root) as { id: number; title: string; source: string });
	}

	markFailed(id: number): void {
		this.db
			.prepare("UPDATE articles SET status = 'failed', attempts = attempts + 1 WHERE id = ?")
			.run(id);
	}

	/** Articles pertinents jamais notifiés (limités aux 2 derniers jours pour éviter les rafales). */
	pendingNotifications(minScore: number): Article[] {
		return this.rows(
			`${SELECT}
			 WHERE a.status = 'done' AND a.notified_at IS NULL AND a.score >= ?
			   AND a.cluster_id IS NULL AND a.dismissed = 0
			   AND a.created_at >= datetime('now', '-2 days')
			 ORDER BY a.score DESC, a.created_at DESC`,
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
		return this.rows(`${SELECT} WHERE a.id = ?`, id)[0];
	}

	count(filters: Filters = {}): number {
		const { where, params } = this.where(filters);
		return (
			this.db.prepare(`SELECT COUNT(*) AS n FROM articles a WHERE ${where}`).get(...params) as {
				n: number;
			}
		).n;
	}

	/** Autres articles du même sujet, rattachés à cet article principal. */
	clusterMembers(id: number): Article[] {
		return this.rows(`${SELECT} WHERE a.cluster_id = ? ORDER BY a.created_at`, id);
	}

	/** Articles proches (plein texte sur le titre et les thèmes), hors du même sujet. */
	related(article: Article, limit = 5): Article[] {
		const fts = toFtsQuery(`${article.title} ${article.tags.join(" ")}`);
		if (!fts) return [];
		const root = article.cluster_id ?? article.id;
		return this.rows(
			`${SELECT} JOIN articles_fts f ON f.rowid = a.id
			 WHERE articles_fts MATCH ? AND a.status = 'done' AND a.cluster_id IS NULL
			   AND a.dismissed = 0 AND a.id <> ?
			 ORDER BY bm25(articles_fts, 8.0, 4.0, 0.0) LIMIT ?`,
			fts,
			root,
			limit,
		);
	}

	/** Actions de lecture. « Pas pertinent » s'applique à tout le groupe de doublons. */
	updateArticle(
		id: number,
		changes: { favorite?: boolean; read?: boolean; dismissed?: boolean },
	): Article | undefined {
		if (changes.favorite !== undefined) {
			this.db.prepare("UPDATE articles SET favorite = ? WHERE id = ?").run(+changes.favorite, id);
		}
		if (changes.read !== undefined) {
			this.db
				.prepare(
					`UPDATE articles SET read_at = ${changes.read ? "datetime('now')" : "NULL"} WHERE id = ?`,
				)
				.run(id);
		}
		if (changes.dismissed !== undefined) {
			this.db
				.prepare("UPDATE articles SET dismissed = ? WHERE id = ? OR cluster_id = ?")
				.run(+changes.dismissed, id, id);
		}
		return this.get(id);
	}

	/** Articles enrichis, du plus récent au plus ancien. */
	list(filters: Filters = {}): Article[] {
		const { where, params } = this.where(filters);
		const paging = filters.limit ? "LIMIT ? OFFSET ?" : "";
		const pagingParams = filters.limit ? [filters.limit, filters.offset ?? 0] : [];
		return this.rows(
			`${SELECT} WHERE ${where} ORDER BY a.created_at DESC, a.id DESC ${paging}`,
			...params,
			...pagingParams,
		);
	}

	/** Meilleurs articles (score puis date). */
	top(filters: Filters = {}): Article[] {
		const { where, params } = this.where(filters);
		return this.rows(
			`${SELECT} WHERE ${where}
			 ORDER BY a.score DESC, coverage DESC, a.created_at DESC, a.id DESC LIMIT ?`,
			...params,
			filters.limit ?? 10,
		);
	}

	/** Recherche plein texte (FTS5, classement BM25 : titre > résumé > contenu). */
	search(query: string, filters: Filters = {}): Article[] {
		const fts = toFtsQuery(query);
		if (!fts) return [];
		// La recherche porte aussi sur les doublons, puis chaque résultat est ramené à son article principal.
		const { where, params } = this.where({ ...filters, includeClustered: true });
		const limit = filters.limit ?? 5;
		const matches = this.db
			.prepare(
				`SELECT COALESCE(a.cluster_id, a.id) AS root
				 FROM articles_fts f JOIN articles a ON a.id = f.rowid
				 WHERE articles_fts MATCH ? AND ${where}
				 ORDER BY bm25(articles_fts, 8.0, 4.0, 1.0), a.created_at DESC
				 LIMIT ? OFFSET ?`,
			)
			.all(fts, ...params, limit * 3, filters.offset ?? 0) as Array<{ root: number }>;
		const roots = [...new Set(matches.map((m) => m.root))].slice(0, limit);
		return roots.map((id) => this.get(id)).filter((a): a is Article => a !== undefined);
	}

	/** Articles par semaine et par thème, sur les N dernières semaines (lundi UTC en clé). */
	trends(weeks: number): {
		byTag: Array<{ week: string; tag: string; n: number }>;
		total: Array<{ week: string; n: number }>;
	} {
		const since = `-${weeks * 7} days`;
		return {
			byTag: this.db
				.prepare(
					`SELECT date(a.created_at, 'weekday 0', '-6 days') AS week, j.value AS tag, COUNT(*) AS n
					 FROM articles a, json_each(a.tags) j
					 WHERE a.status = 'done' AND a.created_at >= datetime('now', ?)
					 GROUP BY week, tag`,
				)
				.all(since) as Array<{ week: string; tag: string; n: number }>,
			total: this.db
				.prepare(
					`SELECT date(created_at, 'weekday 0', '-6 days') AS week, COUNT(*) AS n FROM articles
					 WHERE status = 'done' AND created_at >= datetime('now', ?) GROUP BY week`,
				)
				.all(since) as Array<{ week: string; n: number }>,
		};
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
				 enriched = @enriched, failed = @failed, notified = @notified, duplicates = @duplicates,
				 prompt_tokens = @prompt_tokens, completion_tokens = @completion_tokens,
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

	// ── Sources ────────────────────────────────────────────────────────────

	sources(status?: SourceStatus): SourceRow[] {
		const sql = `SELECT * FROM sources ${status ? "WHERE status = ?" : ""} ORDER BY status, category, name`;
		return this.db.prepare(sql).all(...(status ? [status] : [])) as SourceRow[];
	}

	activeSources(): Source[] {
		return this.sources("active").map(({ name, url, category, lang }) => ({
			name,
			url,
			category,
			lang,
		}));
	}

	source(id: number): SourceRow | undefined {
		return this.db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as SourceRow | undefined;
	}

	sourceByUrl(url: string): SourceRow | undefined {
		return this.db.prepare("SELECT * FROM sources WHERE url = ?").get(url) as SourceRow | undefined;
	}

	/** Ajoute une source. Retourne undefined si l'URL est déjà connue (quel que soit son statut). */
	addSource(source: {
		name: string;
		url: string;
		category?: Category;
		lang?: "fr" | "en";
		status?: SourceStatus;
		origin?: "user" | "ai";
		note?: string | null;
		ai_score?: number | null;
	}): SourceRow | undefined {
		const result = this.db
			.prepare(
				`INSERT OR IGNORE INTO sources (name, url, category, lang, status, origin, note, ai_score)
				 VALUES (@name, @url, @category, @lang, @status, @origin, @note, @ai_score)`,
			)
			.run({
				category: "web",
				lang: "en",
				status: "active",
				origin: "user",
				note: null,
				ai_score: null,
				...source,
			});
		return result.changes > 0 ? this.source(Number(result.lastInsertRowid)) : undefined;
	}

	setSourceStatus(id: number, status: SourceStatus): SourceRow | undefined {
		this.db.prepare("UPDATE sources SET status = ?, failures = 0 WHERE id = ?").run(status, id);
		return this.source(id);
	}

	deleteSource(id: number): boolean {
		return this.db.prepare("DELETE FROM sources WHERE id = ?").run(id).changes > 0;
	}

	/** Résultat de la dernière lecture d'un flux (état de santé de la source). */
	recordSourceResult(
		url: string,
		result: { ok: true; items: number } | { ok: false; error: string },
	): void {
		if (result.ok) {
			this.db
				.prepare(
					`UPDATE sources SET last_success_at = datetime('now'), last_item_count = ?, failures = 0
					 WHERE url = ?`,
				)
				.run(result.items, url);
		} else {
			this.db
				.prepare(
					`UPDATE sources SET last_error = ?, last_error_at = datetime('now'), failures = failures + 1
					 WHERE url = ?`,
				)
				.run(result.error.slice(0, 300), url);
		}
	}

	// ── Consommation de l'IA ───────────────────────────────────────────────

	addUsage(purpose: string, promptTokens: number, completionTokens: number): void {
		this.db
			.prepare(
				`INSERT INTO llm_usage (day, purpose, calls, prompt_tokens, completion_tokens)
				 VALUES (date('now'), ?, 1, ?, ?)
				 ON CONFLICT(day, purpose) DO UPDATE SET calls = calls + 1,
				   prompt_tokens = prompt_tokens + excluded.prompt_tokens,
				   completion_tokens = completion_tokens + excluded.completion_tokens`,
			)
			.run(purpose, promptTokens, completionTokens);
	}

	/** Totaux de tokens depuis une date SQLite (ex. `start of month`), éventuellement pour un usage. */
	usageTotals(since: "today" | "month" | "all", purpose?: string): UsageTotals {
		const from =
			since === "today"
				? "date('now')"
				: since === "month"
					? "date('now', 'start of month')"
					: "'0000'";
		return this.db
			.prepare(
				`SELECT COALESCE(SUM(calls), 0) AS calls, COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
				        COALESCE(SUM(completion_tokens), 0) AS completion_tokens
				 FROM llm_usage WHERE day >= ${from} ${purpose ? "AND purpose = ?" : ""}`,
			)
			.get(...(purpose ? [purpose] : [])) as UsageTotals;
	}

	usageByPurpose(since: "month" | "all" = "month"): Array<UsageTotals & { purpose: string }> {
		const from = since === "month" ? "date('now', 'start of month')" : "'0000'";
		return this.db
			.prepare(
				`SELECT purpose, SUM(calls) AS calls, SUM(prompt_tokens) AS prompt_tokens,
				        SUM(completion_tokens) AS completion_tokens
				 FROM llm_usage WHERE day >= ${from} GROUP BY purpose ORDER BY prompt_tokens DESC`,
			)
			.all() as Array<UsageTotals & { purpose: string }>;
	}

	usageByDay(days = 30): Array<UsageTotals & { day: string }> {
		return this.db
			.prepare(
				`SELECT day, SUM(calls) AS calls, SUM(prompt_tokens) AS prompt_tokens,
				        SUM(completion_tokens) AS completion_tokens
				 FROM llm_usage WHERE day >= date('now', ?) GROUP BY day ORDER BY day`,
			)
			.all(`-${days} days`) as Array<UsageTotals & { day: string }>;
	}

	// ── Rapports ───────────────────────────────────────────────────────────

	addReport(report: { days: number | null; articles: number; content: string }): Report {
		const { lastInsertRowid } = this.db
			.prepare("INSERT INTO reports (days, articles, content) VALUES (@days, @articles, @content)")
			.run(report);
		return this.report(Number(lastInsertRowid)) as Report;
	}

	report(id: number): Report | undefined {
		return this.db.prepare("SELECT * FROM reports WHERE id = ?").get(id) as Report | undefined;
	}

	reports(limit = 30): Array<Omit<Report, "content">> {
		return this.db
			.prepare("SELECT id, created_at, days, articles FROM reports ORDER BY id DESC LIMIT ?")
			.all(limit) as Array<Omit<Report, "content">>;
	}

	deleteReport(id: number): boolean {
		return this.db.prepare("DELETE FROM reports WHERE id = ?").run(id).changes > 0;
	}

	// ── Divers ─────────────────────────────────────────────────────────────

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
		// Un favori reste visible même s'il est rattaché à un autre article.
		if (!filters.includeClustered && !filters.favorite) clauses.push("a.cluster_id IS NULL");
		if (!filters.includeDismissed) clauses.push("a.dismissed = 0");
		if (filters.favorite) clauses.push("a.favorite = 1");
		if (filters.unread) clauses.push("a.read_at IS NULL");
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
		return rows.map((r) => ({
			...r,
			tags: safeJsonArray(r.tags),
			also_in: safeJsonArray(r.also_in ?? "[]"),
			favorite: r.favorite === 1,
			dismissed: r.dismissed === 1,
		}));
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
