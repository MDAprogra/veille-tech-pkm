import type { Config } from "./config.js";
import type { Store } from "./db/store.js";
import type { Llm } from "./llm/mistral.js";
import type { FeedFetcher } from "./pipeline/collect.js";
import type { Scheduler } from "./pipeline/scheduler.js";
import type { WebSearch } from "./services/ask.js";
import type { TextFetcher } from "./services/sources.js";

/** Dépendances partagées par toutes les interfaces (bot, API, MCP). */
export interface App {
	config: Config;
	store: Store;
	scheduler: Scheduler;
	llm?: Llm;
	/** Modèle et fournisseur, pour l'affichage. */
	llmLabel?: string;
	webSearch?: WebSearch;
	fetchFeed: FeedFetcher;
	fetchText: TextFetcher;
	startedAt: Date;
}
