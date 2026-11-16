import type { Store, UsageTotals } from "../db/store.js";

/** Prix en dollars par million de tokens. */
export interface Price {
	input: number;
	output: number;
}

export function cost(
	usage: Pick<UsageTotals, "prompt_tokens" | "completion_tokens">,
	price: Price,
) {
	const value =
		(usage.prompt_tokens * price.input + usage.completion_tokens * price.output) / 1_000_000;
	return Math.round(value * 10_000) / 10_000;
}

/** Consommation de l'IA : aujourd'hui, mois en cours, détail par usage et par jour. */
export function usageSummary(store: Store, price: Price) {
	const withCost = <T extends UsageTotals>(u: T) => ({ ...u, cost: cost(u, price) });
	return {
		price,
		today: withCost(store.usageTotals("today")),
		month: withCost(store.usageTotals("month")),
		total: withCost(store.usageTotals("all")),
		byPurpose: store.usageByPurpose("month").map(withCost),
		byDay: store.usageByDay(30).map(withCost),
	};
}
