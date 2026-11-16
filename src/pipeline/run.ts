import type { Article, RunResult, Store } from "../db/store.js";
import type { Llm } from "../llm/mistral.js";
import { log } from "../logger.js";
import type { Source } from "../sources.js";
import { collectFeeds, type FeedFetcher } from "./collect.js";
import { enrichArticle, InvalidLlmOutput } from "./enrich.js";

export interface PipelineDeps {
	store: Store;
	/** Par défaut : les sources actives enregistrées en base. */
	sources?: Source[];
	fetchFeed: FeedFetcher;
	/** Sans LLM, les articles sont collectés et restent en file d'attente. */
	llm?: Llm;
	notify?: (articles: Article[]) => Promise<void>;
	itemsPerSource: number;
	maxEnrichPerRun: number;
	notifyMinScore: number;
}

/**
 * Une collecte complète :
 * 1. lecture des flux ; 2. insertion des seuls articles inconnus (statut « pending ») ;
 * 3. enrichissement LLM de la file (nouveaux + échecs à retenter) ; 4. notification.
 * Le LLM n'est donc jamais appelé pour un article déjà traité.
 */
export async function runPipeline(deps: PipelineDeps): Promise<RunResult> {
	const { store } = deps;
	const runId = store.startRun();
	const result: RunResult = {
		fetched: 0,
		inserted: 0,
		enriched: 0,
		failed: 0,
		notified: 0,
		sources_failed: [],
		error: null,
		duplicates: 0,
		prompt_tokens: 0,
		completion_tokens: 0,
	};
	const usageBefore = store.usageTotals("all", "enrich");

	try {
		const { articles, failedSources, results } = await collectFeeds(
			deps.sources ?? store.activeSources(),
			deps.fetchFeed,
			{ itemsPerSource: deps.itemsPerSource },
		);
		for (const r of results) {
			store.recordSourceResult(
				r.source.url,
				r.ok ? { ok: true, items: r.items } : { ok: false, error: r.error ?? "erreur inconnue" },
			);
		}
		result.fetched = articles.length;
		result.sources_failed = failedSources;

		const known = store.knownUrls(articles.flatMap((a) => [a.url, a.rawUrl]));
		for (const { rawUrl, ...article } of articles) {
			if (known.has(article.url) || known.has(rawUrl)) continue;
			if (store.insertPending(article)) result.inserted++;
		}
		log.info(`🔍 ${result.fetched} articles lus, ${result.inserted} nouveaux`);

		if (deps.llm) {
			for (const article of store.enrichmentQueue(deps.maxEnrichPerRun)) {
				try {
					// Doublons de sujet : seuls les articles récents sont comparés aux autres sources.
					const candidates = isRecent(article.created_at) ? store.similarRecent(article) : [];
					const enrichment = await enrichArticle(deps.llm, article, candidates);
					if (store.markEnriched(article.id, enrichment)) result.duplicates++;
					result.enriched++;
				} catch (err) {
					if (!(err instanceof InvalidLlmOutput)) {
						// Clé invalide, quota épuisé, panne : inutile d'insister ni de pénaliser les articles.
						log.error("LLM indisponible — enrichissement reporté à la prochaine collecte", err);
						break;
					}
					store.markFailed(article.id);
					result.failed++;
					log.error(`Résumé inexploitable : ${article.title}`, err);
				}
			}
		} else {
			log.warn("Aucun modèle d'IA configuré — articles laissés en file d'attente");
		}

		if (deps.notify) {
			const toNotify = store.pendingNotifications(deps.notifyMinScore);
			if (toNotify.length > 0) {
				await deps.notify(toNotify);
				store.markNotified(toNotify.map((a) => a.id));
				result.notified = toNotify.length;
			}
		}
	} catch (err) {
		result.error = err instanceof Error ? err.message : String(err);
		log.error("Collecte interrompue", err);
	}

	const usageAfter = store.usageTotals("all", "enrich");
	result.prompt_tokens = usageAfter.prompt_tokens - usageBefore.prompt_tokens;
	result.completion_tokens = usageAfter.completion_tokens - usageBefore.completion_tokens;
	store.finishRun(runId, result);
	log.info(
		`✅ Collecte terminée — ${result.inserted} nouveaux, ${result.enriched} résumés (${result.duplicates} doublons de sujet), ${result.failed} échecs, ${result.notified} notifiés` +
			(result.sources_failed.length ? ` — sources KO : ${result.sources_failed.join(", ")}` : ""),
	);
	return result;
}

const RECENT_DAYS = 5;

/** `created_at` est une date SQLite en UTC (« 2026-06-15 08:00:00 »). */
function isRecent(createdAt: string): boolean {
	const date = new Date(`${createdAt.replace(" ", "T")}Z`);
	return Date.now() - date.getTime() < RECENT_DAYS * 86_400_000;
}
