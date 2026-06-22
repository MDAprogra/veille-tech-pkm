import { addLog, notifyNewArticles, startBot, updateCollectStats } from "./bot/telegram.js";
import { fetchRSSFeeds } from "./collectors/rss.js";
import { summarizeArticle } from "./processors/summarizer.js";
import { type EnrichedArticle, initDB, insertArticle } from "./storage/database.js";

function isActiveHours(): boolean {
	const now = new Date();
	const hour = now.toLocaleString("en-US", {
		timeZone: "Europe/Paris",
		hour: "numeric",
		hour12: false,
	});
	const h = parseInt(hour, 10);
	return h >= 9 && h < 19;
}

async function collect() {
	if (!isActiveHours()) {
		console.log("😴 Hors plage horaire (19h-9h) — collecte ignorée.");
		addLog("😴 Collecte ignorée — hors plage horaire");
		return;
	}

	console.log("🔍 Démarrage de la collecte...");
	addLog("🔍 Démarrage de la collecte...");

	const [rssArticles] = await Promise.all([fetchRSSFeeds()]);

	const articles = [...rssArticles];
	const newArticles: EnrichedArticle[] = [];
	let count = 0;

	for (const article of articles) {
		count++;
		console.log(`📝 Résumé (${count}/${articles.length}) : ${article.title}`);
		const { summary, score } = await summarizeArticle(article);
		const result = insertArticle({ ...article, summary, score });
		if (result.changes > 0) {
			newArticles.push({ ...article, summary, score });
		}
	}

	const relevantArticles = newArticles.filter((a) => a.score >= 4);

	if (relevantArticles.length > 0) {
		console.log(`📲 Envoi de ${relevantArticles.length} notifications (score ≥ 4)...`);
		addLog(`📲 ${relevantArticles.length} articles pertinents notifiés (score ≥ 4)`);
		await notifyNewArticles(relevantArticles);
	}

	updateCollectStats();
	addLog(
		`✅ Collecte terminée — ${articles.length} articles, ${newArticles.length} nouveaux, ${relevantArticles.length} pertinents`,
	);
	console.log(`✅ Collecte terminée — ${articles.length} articles traités.`);
}

async function main() {
	initDB();
	startBot();
	await collect();

	setInterval(
		async () => {
			await collect();
		},
		2 * 60 * 60 * 1000,
	);
}

main().catch(console.error);
