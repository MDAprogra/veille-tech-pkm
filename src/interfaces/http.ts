import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { App } from "../app.js";
import type { Filters } from "../db/store.js";
import { log } from "../logger.js";
import { usageSummary } from "../services/cost.js";
import { exportCsv, exportMarkdown } from "../services/format.js";
import { generateReport, trends } from "../services/report.js";
import {
	addSourceFromUrl,
	SourceError,
	type SuggestionReport,
	suggestSources,
} from "../services/sources.js";
import { CATEGORIES, TAGS } from "../sources.js";
import { mountMcp } from "./mcp.js";

const PUBLIC_DIR = fileURLToPath(new URL("../../public", import.meta.url));

export function safeEqual(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

export function bearer(req: Request): string | undefined {
	const header = req.headers.authorization;
	return header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
}

function positiveInt(value: unknown, max: number): number | undefined {
	const n = Number(value);
	return Number.isInteger(n) && n > 0 ? Math.min(n, max) : undefined;
}

const flag = (value: unknown) => value === "1" || value === "true";

function filtersFrom(req: Request): Filters {
	const { min_score, tag, source, days, limit, offset, favorite, unread, dismissed } = req.query;
	return {
		minScore: positiveInt(min_score, 5),
		tag: typeof tag === "string" && tag ? tag : undefined,
		source: typeof source === "string" && source ? source : undefined,
		days: positiveInt(days, 3650),
		limit: positiveInt(limit, 500),
		offset: positiveInt(offset, 1_000_000),
		favorite: flag(favorite) || undefined,
		unread: flag(unread) || undefined,
		includeDismissed: flag(dismissed) || undefined,
	};
}

const articlePatch = z
	.object({ favorite: z.boolean(), read: z.boolean(), dismissed: z.boolean() })
	.partial()
	.strict();

const sourceCreate = z.object({
	url: z.string().min(1).max(500),
	name: z.string().max(80).optional(),
	category: z.enum(CATEGORIES).optional(),
	lang: z.enum(["fr", "en"]).optional(),
});

const sourcePatch = z.object({ status: z.enum(["active", "disabled", "rejected"]) });

const reportCreate = z.object({ days: z.number().int().min(1).max(3650).nullable().optional() });

/** État de la dernière recherche de sources (tâche longue, suivie par interrogation). */
interface SuggestJob {
	running: boolean;
	startedAt: string | null;
	finishedAt: string | null;
	report: SuggestionReport | null;
	error: string | null;
}

export function createHttpApp(app: App): Express {
	const { store, config } = app;
	const server = express();
	server.disable("x-powered-by");
	server.use(cors({ exposedHeaders: ["X-Total-Count"] }));
	server.use(express.json({ limit: "1mb" }));

	const suggestJob: SuggestJob = {
		running: false,
		startedAt: null,
		finishedAt: null,
		report: null,
		error: null,
	};

	const requireAuth = (req: Request, res: Response, next: NextFunction) => {
		const expected = config.http.dashboardToken;
		const token = bearer(req);
		if (!expected) {
			res.status(401).json({ error: "API désactivée : DASHBOARD_TOKEN n'est pas configuré" });
		} else if (!token || !safeEqual(token, expected)) {
			res.status(401).json({ error: "Non autorisé" });
		} else {
			next();
		}
	};

	const idOf = (req: Request) => positiveInt(req.params.id, Number.MAX_SAFE_INTEGER);
	const notFound = (res: Response) => res.status(404).json({ error: "Introuvable" });
	const noLlm = (res: Response) =>
		res.status(503).json({ error: "Aucun modèle d'IA n'est configuré" });

	server.get("/health", (_req, res) => {
		try {
			store.db.prepare("SELECT 1").get();
			res.json({ status: "ok", timestamp: new Date().toISOString() });
		} catch {
			res.status(503).json({ status: "error" });
		}
	});

	server.use(express.static(PUBLIC_DIR));

	const api = express.Router();
	api.use(requireAuth);

	// ── Articles ───────────────────────────────────────────────────────────

	// Sans filtre : tous les articles résumés. `q` active la recherche plein texte.
	// L'en-tête X-Total-Count donne le nombre total d'articles correspondant aux filtres.
	api.get("/articles", (req, res) => {
		const filters = filtersFrom(req);
		const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
		if (q) {
			res.json(store.search(q, { ...filters, limit: filters.limit ?? 50 }));
			return;
		}
		res.setHeader("X-Total-Count", String(store.count(filters)));
		res.json(store.list(filters));
	});

	api.get("/articles/recent", (req, res) => {
		res.json(store.list({ ...filtersFrom(req), limit: positiveInt(req.query.limit, 500) ?? 10 }));
	});

	api.get("/articles/search", (req, res) => {
		const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
		if (!q) {
			res.status(400).json({ error: "Paramètre q requis" });
			return;
		}
		const filters = filtersFrom(req);
		res.json(store.search(q, { ...filters, limit: filters.limit ?? 5 }));
	});

	// Fiche : l'article, les autres sources du même sujet et les articles proches.
	api.get("/articles/:id", (req, res) => {
		const id = idOf(req);
		const article = id ? store.get(id) : undefined;
		if (!article) {
			notFound(res);
			return;
		}
		const root = article.cluster_id ?? article.id;
		res.json({
			article,
			primary: article.cluster_id ? (store.get(article.cluster_id) ?? null) : null,
			coveredBy: store.clusterMembers(root).filter((m) => m.id !== article.id),
			related: store.related(article, 5),
		});
	});

	api.patch("/articles/:id", (req, res) => {
		const id = idOf(req);
		const changes = articlePatch.safeParse(req.body);
		if (!changes.success) {
			res.status(400).json({ error: "Champs acceptés : favorite, read, dismissed (booléens)" });
			return;
		}
		if (!id || !store.get(id)) {
			notFound(res);
			return;
		}
		res.json(store.updateArticle(id, changes.data));
	});

	// ── Statistiques et tendances ──────────────────────────────────────────

	api.get("/stats", (_req, res) => {
		const sources = store.sources();
		res.json({
			...store.stats(),
			favorites: store.count({ favorite: true }),
			unread: store.count({ unread: true }),
			sources: sources.filter((s) => s.status === "active").length,
			suggestedSources: sources.filter((s) => s.status === "suggested").length,
			tags: TAGS,
			nextRunAt: app.scheduler.nextRunAt,
			collecting: app.scheduler.busy,
			usage: usageSummary(store, config.llmPrice),
		});
	});

	api.get("/trends", (req, res) => {
		res.json(trends(store, positiveInt(req.query.weeks, 52) ?? 12));
	});

	api.get("/runs", (req, res) => {
		res.json(store.runs(positiveInt(req.query.limit, 200) ?? 20));
	});

	api.get("/export.md", (req, res) => {
		res.type("text/markdown").send(exportMarkdown(store.list(filtersFrom(req))));
	});

	api.get("/export.csv", (req, res) => {
		res.type("text/csv").send(exportCsv(store.list(filtersFrom(req))));
	});

	api.post("/collect", (_req, res) => {
		if (app.scheduler.busy) {
			res.status(409).json({ error: "Collecte déjà en cours" });
			return;
		}
		void app.scheduler.trigger(true);
		res.status(202).json({ status: "started" });
	});

	// ── Rapports ───────────────────────────────────────────────────────────

	api.get("/reports", (_req, res) => {
		res.json(store.reports());
	});

	api.post("/reports", async (req, res) => {
		const body = reportCreate.safeParse(req.body ?? {});
		if (!body.success) {
			res
				.status(400)
				.json({ error: "days doit être un entier positif, ou null pour toute la veille" });
			return;
		}
		if (!app.llm) {
			noLlm(res);
			return;
		}
		try {
			const report = await generateReport({ store, llm: app.llm }, body.data.days ?? null);
			if (report) res.status(201).json(report);
			else res.status(422).json({ error: "Aucun article sur cette période" });
		} catch (err) {
			log.error("Rapport en échec", err);
			res
				.status(502)
				.json({ error: "Le modèle d'IA n'a pas répondu. Détail dans la page Système." });
		}
	});

	api.get("/reports/:id", (req, res) => {
		const id = idOf(req);
		const report = id ? store.report(id) : undefined;
		if (report) res.json(report);
		else notFound(res);
	});

	api.delete("/reports/:id", (req, res) => {
		const id = idOf(req);
		if (id && store.deleteReport(id)) res.status(204).end();
		else notFound(res);
	});

	// ── Sources ────────────────────────────────────────────────────────────

	api.get("/sources", (_req, res) => {
		res.json({ sources: store.sources(), categories: CATEGORIES, suggestions: suggestJob });
	});

	// L'adresse est lue avant d'être enregistrée ; une page web est acceptée si elle déclare un flux.
	api.post("/sources", async (req, res) => {
		const body = sourceCreate.safeParse(req.body);
		if (!body.success) {
			res.status(400).json({ error: "Adresse du flux requise" });
			return;
		}
		try {
			res.status(201).json(await addSourceFromUrl(body.data, app));
		} catch (err) {
			if (!(err instanceof SourceError)) throw err;
			res.status(422).json({ error: err.message });
		}
	});

	// Tâche longue (lecture de plusieurs flux + deux appels à l'IA) : lancée en arrière-plan.
	api.post("/sources/suggest", (_req, res) => {
		const llm = app.llm;
		if (!llm) {
			noLlm(res);
			return;
		}
		if (suggestJob.running) {
			res.status(409).json({ error: "Recherche déjà en cours" });
			return;
		}
		Object.assign(suggestJob, {
			running: true,
			startedAt: new Date().toISOString(),
			finishedAt: null,
			report: null,
			error: null,
		});
		void suggestSources({ ...app, llm })
			.then((report) => {
				suggestJob.report = report;
			})
			.catch((err) => {
				log.error("Recherche de sources en échec", err);
				suggestJob.error = "La recherche a échoué. Détail dans la page Système.";
			})
			.finally(() => {
				suggestJob.running = false;
				suggestJob.finishedAt = new Date().toISOString();
			});
		res.status(202).json(suggestJob);
	});

	api.patch("/sources/:id", (req, res) => {
		const id = idOf(req);
		const body = sourcePatch.safeParse(req.body);
		if (!body.success) {
			res.status(400).json({ error: "status doit valoir active, disabled ou rejected" });
			return;
		}
		if (!id || !store.source(id)) {
			notFound(res);
			return;
		}
		res.json(store.setSourceStatus(id, body.data.status));
	});

	// Les articles déjà collectés depuis cette source sont conservés.
	api.delete("/sources/:id", (req, res) => {
		const id = idOf(req);
		if (id && store.deleteSource(id)) res.status(204).end();
		else notFound(res);
	});

	// ── Système ────────────────────────────────────────────────────────────

	api.get("/system", (_req, res) => {
		const stats = store.stats();
		res.json({
			startedAt: app.startedAt,
			llm: app.llmLabel ?? null,
			features: {
				telegram: Boolean(config.telegram.token),
				notifications: Boolean(config.telegram.token && config.telegram.chatId),
				webSearch: Boolean(app.webSearch),
				mcpProtected: Boolean(config.http.mcpToken),
				weeklyDigest: config.pipeline.weeklyDigest,
			},
			scheduler: {
				nextRunAt: app.scheduler.nextRunAt,
				collecting: app.scheduler.busy,
				intervalMinutes: config.pipeline.intervalMinutes,
				activeHours: config.pipeline.activeHours,
				itemsPerSource: config.pipeline.itemsPerSource,
				maxEnrichPerRun: config.pipeline.maxEnrichPerRun,
				notifyMinScore: config.pipeline.notifyMinScore,
			},
			articles: { total: stats.total, pending: stats.pending, failed: stats.failed },
			runCount: store.runCount(),
			runs: store.runs(20),
			sources: store.sources(),
			usage: usageSummary(store, config.llmPrice),
			events: log.recent(50),
		});
	});

	api.use((_req, res) => {
		notFound(res);
	});

	server.use("/api", api);
	mountMcp(server, app);

	server.use((_req, res) => {
		notFound(res);
	});
	server.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
		if (err instanceof SyntaxError) {
			res.status(400).json({ error: "JSON invalide" });
			return;
		}
		console.error("❌ Erreur HTTP", err);
		if (!res.headersSent) res.status(500).json({ error: "Erreur interne" });
	});

	return server;
}
