import RSSParser from "rss-parser";
import { toIso } from "../db/migrations.js";
import type { NewArticle } from "../db/store.js";
import { log } from "../logger.js";
import type { Source } from "../sources.js";

const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid)$/i;
const MAX_CONTENT_LENGTH = 6000;

/** Supprime les paramètres de tracking et l'ancre pour que la même page ait toujours la même URL. */
export function canonicalUrl(raw: string): string {
	try {
		const url = new URL(raw.trim());
		for (const key of [...url.searchParams.keys()]) {
			if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
		}
		url.hash = "";
		return url.toString();
	} catch {
		return raw.trim();
	}
}

const ENTITIES: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&#39;": "'",
	"&apos;": "'",
	"&nbsp;": " ",
};

export function cleanText(html: string): string {
	return html
		.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m)
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_CONTENT_LENGTH);
}

export interface FeedItem {
	title?: string;
	link?: string;
	content?: string;
	contentSnippet?: string;
	isoDate?: string;
	pubDate?: string;
}

export type FeedFetcher = (url: string) => Promise<{ items: FeedItem[] }>;

export function createFeedFetcher(): FeedFetcher {
	const parser = new RSSParser({
		timeout: 20_000,
		// Reddit et quelques autres refusent les requêtes sans User-Agent explicite.
		headers: {
			"User-Agent": "veille-tech-pkm/2.0 (+https://github.com/MDAprogra/veille-tech-pkm)",
		},
	});
	return (url) => parser.parseURL(url);
}

export interface CollectResult {
	/** Article + URL brute du flux (pour reconnaître les articles stockés avant la canonicalisation). */
	articles: Array<NewArticle & { rawUrl: string }>;
	failedSources: string[];
}

export async function collectFeeds(
	sources: Source[],
	fetchFeed: FeedFetcher,
	{ itemsPerSource = 5, concurrency = 4 } = {},
): Promise<CollectResult> {
	const articles: CollectResult["articles"] = [];
	const failedSources: string[] = [];
	const seen = new Set<string>();
	const queue = [...sources];

	async function worker() {
		for (let source = queue.shift(); source; source = queue.shift()) {
			try {
				const feed = await fetchFeed(source.url);
				for (const item of feed.items.slice(0, source.limit ?? itemsPerSource)) {
					if (!item.link) continue;
					const url = canonicalUrl(item.link);
					if (seen.has(url)) continue;
					seen.add(url);
					articles.push({
						title: cleanText(item.title ?? "") || "Sans titre",
						url,
						rawUrl: item.link,
						source: source.name,
						content: cleanText(item.content ?? item.contentSnippet ?? ""),
						published_at: toIso(item.isoDate ?? item.pubDate),
					});
				}
			} catch (err) {
				failedSources.push(source.name);
				log.error(`Source en échec : ${source.name}`, err);
			}
		}
	}

	await Promise.all(Array.from({ length: Math.min(concurrency, sources.length) }, worker));
	return { articles, failedSources };
}
