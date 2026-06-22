import cors from "cors";
import express from "express";
import { exportAllArticles, getRecentArticles, searchArticles } from "../storage/database.js";

const app = express();

app.use(cors());
app.use(express.json());

// Middleware d'authentification
const AUTH_TOKEN = process.env.DASHBOARD_TOKEN ?? "";

function requireAuth(
	req: express.Request,
	res: express.Response,
	next: express.NextFunction,
): void {
	const token = req.headers.authorization?.replace("Bearer ", "");
	if (!token || token !== AUTH_TOKEN) {
		res.status(401).json({ error: "Non autorisé" });
		return;
	}
	next();
}

// Routes publiques
app.get("/health", (_req, res) => {
	res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Routes protégées
app.get("/api/articles", requireAuth, (_req, res) => {
	const articles = exportAllArticles();
	res.json(articles);
});

app.get("/api/articles/recent", requireAuth, (req, res) => {
	const limit = Number(req.query.limit) || 10;
	const articles = getRecentArticles(limit);
	res.json(articles);
});

app.get("/api/articles/search", requireAuth, (req, res) => {
	const query = String(req.query.q ?? "");
	if (!query) {
		res.status(400).json({ error: "Paramètre q requis" });
		return;
	}
	const articles = searchArticles(query);
	res.json(articles);
});

app.get("/api/stats", requireAuth, (_req, res) => {
	const all = exportAllArticles();
	const recent = getRecentArticles(1);

	const bySource = all.reduce<Record<string, number>>((acc, a) => {
		acc[a.source] = (acc[a.source] ?? 0) + 1;
		return acc;
	}, {});

	const scoreDistribution = all.reduce<Record<number, number>>((acc, a) => {
		acc[a.score] = (acc[a.score] ?? 0) + 1;
		return acc;
	}, {});

	res.json({
		total: all.length,
		lastArticle: recent[0] ?? null,
		bySource,
		scoreDistribution,
	});
});

export function startAPI(port = 3000) {
	app.listen(port, () => {
		console.log(`🌐 API démarrée sur le port ${port}`);
	});
}

export default app;
