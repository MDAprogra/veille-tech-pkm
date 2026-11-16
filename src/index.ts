import { tavily } from "@tavily/core";
import type { App } from "./app.js";
import { loadConfig } from "./config.js";
import { Store } from "./db/store.js";
import { createHttpApp } from "./interfaces/http.js";
import { createTelegram, type TelegramInterface } from "./interfaces/telegram.js";
import { createMistral } from "./llm/mistral.js";
import { log } from "./logger.js";
import { createFeedFetcher } from "./pipeline/collect.js";
import { runPipeline } from "./pipeline/run.js";
import { mondayKey, Scheduler } from "./pipeline/scheduler.js";
import { analyze } from "./services/analyze.js";
import type { WebSearch } from "./services/ask.js";
import { SOURCES } from "./sources.js";

const config = loadConfig();
const store = new Store(config.db.path);

const llm = config.mistral.apiKey
	? createMistral(config.mistral.apiKey, config.mistral.model, {
			minIntervalMs: config.mistral.minIntervalMs,
		})
	: undefined;

let webSearch: WebSearch | undefined;
if (config.tavily.apiKey) {
	const client = tavily({ apiKey: config.tavily.apiKey });
	webSearch = async (query) => {
		const { results } = await client.search(query, { maxResults: 3, searchDepth: "basic" });
		return results.map((r) => ({ title: r.title, url: r.url, content: r.content ?? "" }));
	};
}

let telegram: TelegramInterface | undefined;
const fetchFeed = createFeedFetcher();
const [lastRun] = store.runs(1);

const scheduler = new Scheduler({
	intervalMinutes: config.pipeline.intervalMinutes,
	activeHours: config.pipeline.activeHours,
	timezone: config.pipeline.timezone,
	lastRunAt: lastRun ? new Date(`${lastRun.started_at.replace(" ", "T")}Z`) : null,
	run: () =>
		runPipeline({
			store,
			sources: SOURCES,
			fetchFeed,
			llm,
			notify:
				telegram && config.telegram.chatId
					? (articles) => telegram?.notify(articles) ?? Promise.resolve()
					: undefined,
			itemsPerSource: config.pipeline.itemsPerSource,
			maxEnrichPerRun: config.pipeline.maxEnrichPerRun,
			notifyMinScore: config.pipeline.notifyMinScore,
		}),
	afterRun: weeklyDigest,
});

/** Chaque lundi, après la première collecte de la journée : synthèse des 7 derniers jours. */
async function weeklyDigest(): Promise<void> {
	if (!config.pipeline.weeklyDigest || !llm || !telegram || !config.telegram.chatId) return;
	const monday = mondayKey(new Date(), config.pipeline.timezone);
	if (!monday || store.getMeta("last_digest") === monday) return;
	const report = await analyze({ store, llm }, { days: 7 });
	if (report) await telegram.sendText(`🗞️ Digest hebdomadaire\n\n${report}`);
	store.setMeta("last_digest", monday);
}

const app: App = { config, store, scheduler, llm, webSearch, startedAt: new Date() };

if (config.telegram.token) {
	telegram = createTelegram(app, config.telegram.token);
	telegram.start();
	if (!config.telegram.chatId) {
		log.warn("TELEGRAM_CHAT_ID absent : bot ouvert à tous et notifications désactivées");
	}
} else {
	log.warn("TELEGRAM_BOT_TOKEN absent : bot Telegram désactivé");
}
if (!config.http.dashboardToken)
	log.warn("DASHBOARD_TOKEN absent : API et tableau de bord désactivés");
if (!config.http.mcpToken)
	log.warn("MCP_TOKEN absent : endpoint /mcp accessible sans authentification");

const httpServer = createHttpApp(app).listen(config.http.port, () => {
	log.info(`🌐 API, tableau de bord et MCP sur le port ${config.http.port}`);
});

scheduler.start();

async function shutdown(signal: string): Promise<void> {
	log.info(`🛑 ${signal} reçu — arrêt`);
	scheduler.stop();
	await telegram?.stop().catch(() => {});
	httpServer.close();
	store.close();
	process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
