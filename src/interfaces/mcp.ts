import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import type { App } from "../app.js";
import type { Article, Store } from "../db/store.js";
import { log } from "../logger.js";
import { articleMarkdown, frenchDate, stars, weekOf } from "../services/format.js";
import { TAGS } from "../sources.js";
import { bearer, safeEqual } from "./http.js";

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const list = (articles: Article[]) => articles.map(articleMarkdown).join("\n\n---\n\n");

const tag = z.enum(TAGS).optional().describe("Filtrer sur un thème");
const minScore = (fallback: number) =>
	z.number().int().min(0).max(5).optional().default(fallback).describe("Score minimum (0-5)");
const days = z.number().int().positive().optional().describe("Limiter aux N derniers jours");

export function createMcpServer(store: Store): McpServer {
	const server = new McpServer({ name: "veille-tech-pkm", version: "2.0.0" });

	server.registerTool(
		"search_articles",
		{
			description:
				"Recherche plein texte dans la base de veille technologique (titre, résumé, contenu), classée par pertinence",
			inputSchema: {
				query: z.string().min(1).describe("Mots-clés ou question"),
				limit: z
					.number()
					.int()
					.min(1)
					.max(50)
					.optional()
					.default(5)
					.describe("Nombre de résultats"),
				min_score: minScore(0),
				tag,
				days,
			},
		},
		async ({ query, limit, min_score, tag, days }) => {
			const articles = store.search(query, { limit, minScore: min_score, tag, days });
			return text(articles.length ? list(articles) : `Aucun article trouvé pour "${query}"`);
		},
	);

	server.registerTool(
		"get_recent_articles",
		{
			description: "Derniers articles collectés et résumés",
			inputSchema: {
				limit: z
					.number()
					.int()
					.min(1)
					.max(100)
					.optional()
					.default(10)
					.describe("Nombre d'articles"),
				min_score: minScore(0),
				tag,
			},
		},
		async ({ limit, min_score, tag }) => {
			const articles = store.list({ limit, minScore: min_score, tag });
			return text(articles.length ? list(articles) : "Aucun article en base.");
		},
	);

	server.registerTool(
		"get_stats",
		{ description: "Statistiques de la base de veille (volumes, sources, thèmes, scores)" },
		async () => {
			const s = store.stats();
			const lines = (record: Record<string, number>) =>
				Object.entries(record)
					.map(([k, n]) => `- ${k} : ${n}`)
					.join("\n") || "- (aucun)";
			return text(
				[
					"# Statistiques de la veille",
					"",
					`- **Articles résumés** : ${s.total}`,
					`- **En attente / en échec** : ${s.pending} / ${s.failed}`,
					`- **Score moyen** : ${s.averageScore ?? "n/a"}/5`,
					"",
					"## Par source",
					lines(s.bySource),
					"",
					"## Par thème",
					lines(s.byTag),
					"",
					"## Par score",
					lines(s.scoreDistribution),
				].join("\n"),
			);
		},
	);

	server.registerTool(
		"export_all",
		{
			description:
				"Exporte les articles de la veille en Markdown. Utiliser min_score, tag ou days pour limiter le volume.",
			inputSchema: { min_score: minScore(0), tag, days },
		},
		async ({ min_score, tag, days }) => {
			const articles = store.list({ minScore: min_score, tag, days });
			return text(articles.length ? list(articles) : "Aucun article ne correspond.");
		},
	);

	server.registerTool(
		"get_timeline",
		{
			description:
				"Chronologie de la veille semaine par semaine : volume, thèmes dominants, meilleurs articles",
			inputSchema: {
				weeks: z
					.number()
					.int()
					.min(1)
					.max(52)
					.optional()
					.default(12)
					.describe("Nombre de semaines"),
				min_score: minScore(3),
			},
		},
		async ({ weeks, min_score }) => {
			const byWeek = new Map<string, Article[]>();
			for (const a of store.list({ minScore: min_score, days: weeks * 7 })) {
				const week = weekOf(a.created_at);
				byWeek.set(week, [...(byWeek.get(week) ?? []), a]);
			}
			const sorted = [...byWeek.entries()].sort(([a], [b]) => b.localeCompare(a)).slice(0, weeks);
			if (sorted.length === 0) return text("Aucun article sur la période.");

			const sections = sorted.map(([week, articles]) => {
				const count = (values: string[]) => {
					const counts = new Map<string, number>();
					for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
					return [...counts.entries()].sort(([, a], [, b]) => b - a);
				};
				const themes = count(articles.flatMap((a) => a.tags))
					.slice(0, 5)
					.map(([t, n]) => `${t} (${n})`);
				const [topSource] = count(articles.map((a) => a.source));
				const best = [...articles].sort((a, b) => b.score - a.score).slice(0, 3);
				return [
					`## 📅 Semaine du ${frenchDate(week)}`,
					`*${articles.length} articles*`,
					`**🔑 Thèmes** : ${themes.join(", ") || "non étiquetés"}`,
					`**📰 Source principale** : ${topSource[0]} (${topSource[1]} articles)`,
					"",
					"**⭐ Top articles**",
					...best.map(
						(a) =>
							`- ${stars(a.score)} ${a.title} *(${a.source})*\n  > ${(a.summary ?? "").slice(0, 200)}`,
					),
				].join("\n");
			});
			return text(`# Chronologie de la veille\n\n${sections.join("\n\n---\n\n")}`);
		},
	);

	return server;
}

/**
 * Endpoint MCP (Streamable HTTP, sans état : un serveur par requête).
 * Si MCP_TOKEN est défini, il est exigé en en-tête `Authorization: Bearer …`
 * ou dans l'URL (`/mcp/<token>`) pour les clients qui ne savent pas envoyer d'en-tête.
 */
export function mountMcp(server: Express, app: App): void {
	const expected = app.config.http.mcpToken;

	const handle = async (req: Request, res: Response) => {
		if (expected) {
			const provided = (req.params.token as string | undefined) ?? bearer(req);
			if (!provided || !safeEqual(provided, expected)) {
				res.status(401).json({ error: "Non autorisé" });
				return;
			}
		}
		if (req.method !== "POST") {
			res.status(405).json({
				jsonrpc: "2.0",
				error: { code: -32000, message: "Méthode non autorisée : utiliser POST" },
				id: null,
			});
			return;
		}
		req.headers.accept ??= "application/json, text/event-stream";
		const mcp = createMcpServer(app.store);
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
		res.on("close", () => {
			void transport.close();
			void mcp.close();
		});
		try {
			await mcp.connect(transport);
			await transport.handleRequest(req, res, req.body);
		} catch (err) {
			log.error("Requête MCP en échec", err);
			if (!res.headersSent) {
				res.status(500).json({
					jsonrpc: "2.0",
					error: { code: -32603, message: "Erreur interne" },
					id: null,
				});
			}
		}
	};

	server.all("/mcp", handle);
	server.all("/mcp/:token", handle);
}
