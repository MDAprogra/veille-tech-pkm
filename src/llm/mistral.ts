import { Mistral } from "@mistralai/mistralai";
import { log } from "../logger.js";

export interface Llm {
	complete(prompt: string, options?: { json?: boolean; maxTokens?: number }): Promise<string>;
}

export interface RetryOptions {
	attempts?: number;
	/** Délai de base du backoff exponentiel (15 s, 30 s, 60 s…). */
	baseDelayMs?: number;
	/** Intervalle minimal entre deux appels (respect du rate limit). */
	minIntervalMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function statusOf(err: unknown): number | undefined {
	if (typeof err !== "object" || err === null) return undefined;
	const e = err as { statusCode?: unknown; status?: unknown };
	if (typeof e.statusCode === "number") return e.statusCode;
	if (typeof e.status === "number") return e.status;
	return undefined;
}

/** Une erreur sans code HTTP est une erreur réseau : on retente aussi. */
export function isRetryable(err: unknown): boolean {
	const status = statusOf(err);
	return status === undefined || status === 408 || status === 429 || status >= 500;
}

/** Ajoute cadence minimale et retry avec backoff autour de n'importe quel appel LLM. */
export function withRetry(
	call: (prompt: string, options?: { json?: boolean; maxTokens?: number }) => Promise<string>,
	{ attempts = 4, baseDelayMs = 15_000, minIntervalMs = 0 }: RetryOptions = {},
): Llm {
	let nextSlot = 0;
	return {
		async complete(prompt, options) {
			for (let attempt = 1; ; attempt++) {
				const wait = nextSlot - Date.now();
				if (wait > 0) await sleep(wait);
				nextSlot = Date.now() + minIntervalMs;
				try {
					return await call(prompt, options);
				} catch (err) {
					if (attempt >= attempts || !isRetryable(err)) throw err;
					const delay = baseDelayMs * 2 ** (attempt - 1);
					log.warn(
						`LLM indisponible (${statusOf(err) ?? "réseau"}) — nouvel essai dans ${Math.round(delay / 1000)}s (${attempt}/${attempts - 1})`,
					);
					await sleep(delay);
				}
			}
		},
	};
}

export function createMistral(apiKey: string, model: string, retry: RetryOptions = {}): Llm {
	const client = new Mistral({ apiKey, timeoutMs: 60_000 });
	return withRetry(async (prompt, options) => {
		const result = await client.chat.complete({
			model,
			messages: [{ role: "user", content: prompt }],
			temperature: 0.2,
			maxTokens: options?.maxTokens,
			responseFormat: options?.json ? { type: "json_object" } : undefined,
		});
		const content = result.choices?.[0]?.message?.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content.map((chunk) => ("text" in chunk ? chunk.text : "")).join("");
		}
		return "";
	}, retry);
}
