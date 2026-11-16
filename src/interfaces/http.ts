import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { App } from "../app.js";
import type { Filters } from "../db/store.js";
import { exportCsv, exportMarkdown } from "../services/format.js";
import { SOURCES, TAGS } from "../sources.js";
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

function filtersFrom(req: Request): Filters {
	const { min_score, tag, source, days, limit, offset } = req.query;
	return {
		minScore: positiveInt(min_score, 5),
		tag: typeof tag === "string" && tag ? tag : undefined,
		source: typeof source === "string" && source ? source : undefined,
		days: positiveInt(days, 3650),
		limit: positiveInt(limit, 500),
		offset: positiveInt(offset, 1_000_000),
	};
}

export function createHttpApp(app: App): Express {
	const { store, config } = app;
	const server = express();
	server.disable("x-powered-by");
	server.use(cors());
	server.use(express.json({ limit: "1mb" }));

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

	// Sans filtre : tous les articles résumés (comportement historique). `q` active la recherche plein texte.
	api.get("/articles", (req, res) => {
		const filters = filtersFrom(req);
		const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
		res.json(q ? store.search(q, { ...filters, limit: filters.limit ?? 50 }) : store.list(filters));
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

	api.get("/stats", (_req, res) => {
		res.json({
			...store.stats(),
			sources: SOURCES.length,
			tags: TAGS,
			nextRunAt: app.scheduler.nextRunAt,
			collecting: app.scheduler.busy,
		});
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

	server.use("/api", api);
	mountMcp(server, app);

	server.use((_req, res) => {
		res.status(404).json({ error: "Introuvable" });
	});
	server.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
		console.error("❌ Erreur HTTP", err);
		if (!res.headersSent) res.status(500).json({ error: "Erreur interne" });
	});

	return server;
}
