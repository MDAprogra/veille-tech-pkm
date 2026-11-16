import type { Report, Store } from "../db/store.js";
import type { Llm } from "../llm/mistral.js";
import { analyze } from "./analyze.js";
import { frenchDate, weekOf } from "./format.js";

/** Génère un rapport de tendances, le met en forme en Markdown et l'archive. */
export async function generateReport(
	deps: { store: Store; llm: Llm },
	days: number | null,
): Promise<Report | null> {
	const articles = deps.store.count({ days: days ?? undefined });
	const body = await analyze(deps, { days: days ?? undefined });
	if (!body) return null;
	const period = days ? `${days} derniers jours` : "toute la veille";
	const content = [
		`# Rapport de veille technologique — ${period}`,
		"",
		`> Généré le ${frenchDate(new Date().toISOString())} à partir de ${articles} articles.`,
		"",
		body,
		"",
	].join("\n");
	return deps.store.addReport({ days, articles, content });
}

/** Séries hebdomadaires par thème, sur des semaines continues (les semaines vides valent 0). */
export function trends(store: Store, weeks: number) {
	const { byTag, total } = store.trends(weeks);
	const labels: string[] = [];
	const cursor = new Date(`${weekOf(new Date().toISOString())}T00:00:00Z`);
	for (let i = 0; i < weeks; i++) {
		labels.unshift(cursor.toISOString().slice(0, 10));
		cursor.setUTCDate(cursor.getUTCDate() - 7);
	}
	const index = new Map(labels.map((label, i) => [label, i]));
	const zeros = () => labels.map(() => 0);
	const totals = zeros();
	for (const row of total) {
		const i = index.get(row.week);
		if (i !== undefined) totals[i] = row.n;
	}
	const series: Record<string, number[]> = {};
	for (const row of byTag) {
		const i = index.get(row.week);
		if (i === undefined) continue;
		series[row.tag] ??= zeros();
		series[row.tag][i] = row.n;
	}
	return { weeks: labels, total: totals, series };
}
