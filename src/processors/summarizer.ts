import { Mistral } from "@mistralai/mistralai";
import type { Article } from "../collectors/rss.js";
import { config } from "../config/index.js";

const client = new Mistral({ apiKey: config.mistral.apiKey });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface MistralError {
	status: number;
}

function isMistralError(err: unknown): err is MistralError {
	return (
		typeof err === "object" &&
		err !== null &&
		"status" in err &&
		typeof (err as MistralError).status === "number"
	);
}

export async function summarizeArticle(
	article: Article,
): Promise<{ summary: string; score: number }> {
	const prompt = `
Tu es un assistant de veille technologique spécialisé en développement web Full Stack.

Analyse cet article et réponds UNIQUEMENT avec un JSON valide (sans markdown, sans backticks) :
{
  "summary": "Résumé en 3-4 phrases concises en français : idée principale, pertinence Full Stack, pourquoi c'est important",
  "score": 3
}

Le score va de 1 à 5 selon la pertinence pour un développeur Full Stack junior/mid en 2026 :
- 5 : Indispensable (nouvelle majeure React/Node/TS, sécurité critique, outil révolutionnaire)
- 4 : Très pertinent (bonne pratique, outil utile, tendance importante)
- 3 : Intéressant (contexte général, culture tech)
- 2 : Peu pertinent (sujet trop spécialisé ou hors scope)
- 1 : Non pertinent (hors sujet complet)

Titre : ${article.title}
Source : ${article.source}
Contenu : ${article.content.slice(0, 2000)}
  `;

	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			const result = await client.chat.complete({
				model: "mistral-small-latest",
				messages: [{ role: "user", content: prompt }],
			});
			await sleep(1000);

			const raw = (result.choices?.[0]?.message?.content as string) ?? "{}";
			const parsed = JSON.parse(raw);
			return {
				summary: parsed.summary ?? "Résumé indisponible.",
				score: parsed.score ?? 3,
			};
		} catch (err: unknown) {
			if (isMistralError(err) && err.status === 429) {
				console.log(`⏳ Rate limit — attente 60s avant retry (${attempt}/3)`);
				await sleep(60000);
			} else {
				console.error(`❌ Erreur résumé pour "${article.title}":`, err);
				return { summary: "Résumé indisponible.", score: 0 };
			}
		}
	}

	return { summary: "Résumé indisponible.", score: 0 };
}