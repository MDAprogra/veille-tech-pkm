import type { App } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/db/store.js";
import type { Llm } from "../src/llm/mistral.js";
import type { FeedFetcher, FeedItem } from "../src/pipeline/collect.js";
import type { PipelineDeps } from "../src/pipeline/run.js";
import { Scheduler } from "../src/pipeline/scheduler.js";
import type { Source } from "../src/sources.js";

export const SOURCE: Source = {
	name: "Flux test",
	url: "https://feed.test/rss",
	category: "web",
	lang: "fr",
};

export function fakeFeed(items: FeedItem[]): FeedFetcher {
	return async () => ({ items });
}

export function fakeLlm(reply: (prompt: string) => string | Promise<string>) {
	const calls: string[] = [];
	const llm: Llm = {
		async complete(prompt) {
			calls.push(prompt);
			return reply(prompt);
		},
	};
	return { llm, calls };
}

export const goodReply = (score = 4, tags = ["react"]) =>
	JSON.stringify({
		summary: "Un résumé suffisamment long pour être accepté par la validation.",
		score,
		tags,
	});

export function pipelineDeps(store: Store, overrides: Partial<PipelineDeps> = {}): PipelineDeps {
	return {
		store,
		sources: [SOURCE],
		fetchFeed: fakeFeed([]),
		itemsPerSource: 5,
		maxEnrichPerRun: 50,
		notifyMinScore: 4,
		...overrides,
	};
}

/** Insère un article déjà enrichi. */
export function seed(
	store: Store,
	article: {
		title: string;
		url: string;
		summary?: string;
		content?: string;
		score?: number;
		tags?: string[];
		source?: string;
	},
): number {
	store.insertPending({
		title: article.title,
		url: article.url,
		source: article.source ?? "Flux test",
		content: article.content ?? "",
		published_at: "2026-06-15T08:00:00.000Z",
	});
	const { id } = store.db.prepare("SELECT id FROM articles WHERE url = ?").get(article.url) as {
		id: number;
	};
	store.markEnriched(id, {
		summary: article.summary ?? "Résumé de test.",
		score: article.score ?? 4,
		tags: article.tags ?? [],
	});
	return id;
}

export function testApp(env: Record<string, string> = {}): App {
	const config = loadConfig({ DASHBOARD_TOKEN: "secret", ...env });
	const store = new Store(":memory:");
	const scheduler = new Scheduler({
		intervalMinutes: 120,
		activeHours: { start: 0, end: 24 },
		timezone: "Europe/Paris",
		run: async () => ({
			fetched: 0,
			inserted: 0,
			enriched: 0,
			failed: 0,
			notified: 0,
			sources_failed: [],
			error: null,
		}),
	});
	return { config, store, scheduler, startedAt: new Date() };
}
