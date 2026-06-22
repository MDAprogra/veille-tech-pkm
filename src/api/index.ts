import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { exportAllArticles, getRecentArticles, searchArticles } from "../storage/database.js";

const app = express();

app.use(cors());
app.use(express.json());

const AUTH_TOKEN = process.env.DASHBOARD_TOKEN ?? "";

function requireAuth(req: Request, res: Response, next: NextFunction): void {
	const token = req.headers.authorization?.replace("Bearer ", "");
	if (!token || token !== AUTH_TOKEN) {
		res.status(401).json({ error: "Non autorisé" });
		return;
	}
	next();
}

app.get("/health", (_req: Request, res: Response) => {
	res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/api/articles", requireAuth, (_req: Request, res: Response) => {
	const articles = exportAllArticles();
	res.json(articles);
});

app.get("/api/articles/recent", requireAuth, (req: Request, res: Response) => {
	const limit = Number(req.query.limit) || 10;
	const articles = getRecentArticles(limit);
	res.json(articles);
});

app.get("/api/articles/search", requireAuth, (req: Request, res: Response) => {
	const query = String(req.query.q ?? "");
	if (!query) {
		res.status(400).json({ error: "Paramètre q requis" });
		return;
	}
	const articles = searchArticles(query);
	res.json(articles);
});

app.get("/api/stats", requireAuth, (_req: Request, res: Response) => {
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
