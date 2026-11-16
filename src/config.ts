import { z } from "zod";

// Charge .env en local s'il existe (Node ≥ 20.12) — en production les secrets viennent de Fly.io.
try {
	process.loadEnvFile();
} catch {
	// Pas de fichier .env : on s'appuie sur l'environnement du processus.
}

const optional = z
	.string()
	.optional()
	.transform((v) => v?.trim() || undefined);

const bool = (fallback: boolean) =>
	z
		.string()
		.optional()
		.transform((v) => (v === undefined || v === "" ? fallback : /^(1|true|yes|on)$/i.test(v)));

const int = (fallback: number, min = 0) =>
	z
		.string()
		.optional()
		.transform((v) => (v === undefined || v === "" ? fallback : Number(v)))
		.pipe(z.number().int().min(min));

const hours = z
	.string()
	.optional()
	.transform((v) => v?.trim() || "9-19")
	.pipe(z.string().regex(/^\d{1,2}-\d{1,2}$/, "format attendu : 9-19"))
	.transform((v) => {
		const [start, end] = v.split("-").map(Number);
		return { start, end };
	});

const schema = z.object({
	MISTRAL_API_KEY: optional,
	MISTRAL_MODEL: optional,
	MISTRAL_MIN_INTERVAL_MS: int(1500),
	LLM_BASE_URL: optional,
	LLM_API_KEY: optional,
	LLM_MODEL: optional,
	TELEGRAM_BOT_TOKEN: optional,
	TELEGRAM_CHAT_ID: optional,
	TELEGRAM_PUBLIC: bool(false),
	TAVILY_API_KEY: optional,
	DASHBOARD_TOKEN: optional,
	MCP_TOKEN: optional,
	DB_PATH: optional,
	EXPORT_DIR: optional,
	PORT: int(3000, 1),
	COLLECT_INTERVAL_MINUTES: int(120, 1),
	ACTIVE_HOURS: hours,
	ITEMS_PER_SOURCE: int(5, 1),
	MAX_ENRICH_PER_RUN: int(60, 1),
	NOTIFY_MIN_SCORE: int(4, 1),
	WEEKLY_DIGEST: bool(true),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
	const parsed = schema.safeParse(env);
	if (!parsed.success) {
		const details = parsed.error.issues
			.map((i) => `  - ${i.path.join(".")} : ${i.message}`)
			.join("\n");
		throw new Error(`Configuration invalide :\n${details}`);
	}
	const e = parsed.data;
	if (e.LLM_BASE_URL && (!e.LLM_API_KEY || !e.LLM_MODEL)) {
		throw new Error("Configuration invalide : LLM_BASE_URL exige aussi LLM_API_KEY et LLM_MODEL");
	}
	if (e.LLM_BASE_URL && !URL.canParse(e.LLM_BASE_URL)) {
		throw new Error("Configuration invalide : LLM_BASE_URL n'est pas une URL");
	}
	return {
		/** Fournisseur compatible OpenAI ; prioritaire sur Mistral s'il est configuré. */
		llm: e.LLM_BASE_URL
			? { baseUrl: e.LLM_BASE_URL, apiKey: e.LLM_API_KEY as string, model: e.LLM_MODEL as string }
			: undefined,
		mistral: {
			apiKey: e.MISTRAL_API_KEY,
			model: e.MISTRAL_MODEL ?? "mistral-small-latest",
			minIntervalMs: e.MISTRAL_MIN_INTERVAL_MS,
		},
		telegram: {
			token: e.TELEGRAM_BOT_TOKEN,
			chatId: e.TELEGRAM_CHAT_ID,
			/** Si false (défaut), seul TELEGRAM_CHAT_ID peut utiliser le bot. */
			public: e.TELEGRAM_PUBLIC,
		},
		tavily: { apiKey: e.TAVILY_API_KEY },
		http: { port: e.PORT, dashboardToken: e.DASHBOARD_TOKEN, mcpToken: e.MCP_TOKEN },
		db: { path: e.DB_PATH ?? "./data/veille.db" },
		exportDir: e.EXPORT_DIR,
		pipeline: {
			intervalMinutes: e.COLLECT_INTERVAL_MINUTES,
			activeHours: e.ACTIVE_HOURS,
			itemsPerSource: e.ITEMS_PER_SOURCE,
			maxEnrichPerRun: e.MAX_ENRICH_PER_RUN,
			notifyMinScore: e.NOTIFY_MIN_SCORE,
			weeklyDigest: e.WEEKLY_DIGEST,
			timezone: "Europe/Paris",
		},
	};
}
