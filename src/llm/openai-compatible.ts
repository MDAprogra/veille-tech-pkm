import { log } from "../logger.js";
import { type Llm, type RetryOptions, withRetry } from "./mistral.js";

export class HttpError extends Error {
	constructor(
		readonly statusCode: number,
		message: string,
	) {
		super(message);
	}
}

interface ChatResponse {
	choices?: Array<{ message?: { content?: string | Array<{ text?: string }> | null } }>;
}

/**
 * Client pour toute API compatible OpenAI (`POST {baseUrl}/chat/completions`) :
 * Eden AI, Scaleway, OVHcloud AI Endpoints, EUrouter, Mistral…
 */
export function createOpenAICompatible(
	options: { baseUrl: string; apiKey: string; model: string; timeoutMs?: number },
	retry: RetryOptions = {},
): Llm {
	const url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
	// Le mode JSON n'est pas accepté partout : désactivé automatiquement au premier refus.
	let jsonMode = true;

	async function call(prompt: string, opts?: { json?: boolean; maxTokens?: number }) {
		const useJson = Boolean(opts?.json && jsonMode);
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
			body: JSON.stringify({
				model: options.model,
				messages: [{ role: "user", content: prompt }],
				temperature: 0.2,
				...(opts?.maxTokens ? { max_tokens: opts.maxTokens } : {}),
				...(useJson ? { response_format: { type: "json_object" } } : {}),
			}),
			signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
		});
		const body = await res.text();

		if (!res.ok) {
			if (useJson && res.status === 400 && /response_format|json/i.test(body)) {
				jsonMode = false;
				log.warn("Mode JSON refusé par le fournisseur — désactivé");
				return call(prompt, opts);
			}
			throw new HttpError(res.status, `HTTP ${res.status} : ${body.slice(0, 300)}`);
		}

		let data: ChatResponse;
		try {
			data = JSON.parse(body) as ChatResponse;
		} catch {
			throw new HttpError(502, "Réponse du fournisseur illisible");
		}
		const content = data.choices?.[0]?.message?.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) return content.map((c) => c.text ?? "").join("");
		return "";
	}

	return withRetry(call, retry);
}
