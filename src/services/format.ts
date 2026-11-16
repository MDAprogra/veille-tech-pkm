import type { Article } from "../db/store.js";

export function stars(score: number): string {
	return score > 0 ? "⭐".repeat(Math.min(5, score)) : "—";
}

export function frenchDate(iso: string | null): string {
	if (!iso) return "date inconnue";
	// created_at est stocké par SQLite en UTC sans suffixe (« 2026-06-15 08:00:00 »).
	const date = new Date(/^\d{4}-\d{2}-\d{2} /.test(iso) ? `${iso.replace(" ", "T")}Z` : iso);
	if (Number.isNaN(date.getTime())) return iso;
	return date.toLocaleDateString("fr-FR", {
		day: "numeric",
		month: "long",
		year: "numeric",
		timeZone: "Europe/Paris",
	});
}

export function articleMarkdown(a: Article): string {
	return [
		`## ${a.title}`,
		"",
		`- **Source** : ${a.source}`,
		`- **Date** : ${frenchDate(a.published_at ?? a.created_at)}`,
		`- **Score** : ${a.score}/5`,
		...(a.tags.length ? [`- **Thèmes** : ${a.tags.join(", ")}`] : []),
		...(a.coverage > 1
			? [`- **Couverture** : ${a.coverage} sources (aussi : ${a.also_in.join(", ")})`]
			: []),
		`- **Lien** : ${a.url}`,
		"",
		`**Résumé** : ${a.summary ?? "—"}`,
	].join("\n");
}

export function exportMarkdown(articles: Article[], date = new Date()): string {
	const day = date.toISOString().slice(0, 10);
	const header = `# Export Veille Technologique — ${day}\n\n> ${articles.length} articles collectés\n`;
	return `${[header, ...articles.map(articleMarkdown)].join("\n---\n\n")}\n`;
}

function csvCell(value: unknown): string {
	const text = String(value ?? "");
	return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Export tabulaire (dataset pour analyse ou entraînement d'un modèle). */
export function exportCsv(articles: Article[]): string {
	const header = "id,title,url,source,score,tags,published_at,created_at,summary,coverage,favorite";
	const lines = articles.map((a) =>
		[
			a.id,
			a.title,
			a.url,
			a.source,
			a.score,
			a.tags.join("|"),
			a.published_at,
			a.created_at,
			a.summary,
			a.coverage,
			a.favorite ? 1 : 0,
		]
			.map(csvCell)
			.join(","),
	);
	return `${[header, ...lines].join("\n")}\n`;
}

/** Lundi (UTC) de la semaine d'une date SQLite/ISO, au format AAAA-MM-JJ. */
export function weekOf(iso: string): string {
	const date = new Date(/^\d{4}-\d{2}-\d{2} /.test(iso) ? `${iso.replace(" ", "T")}Z` : iso);
	const offset = (date.getUTCDay() + 6) % 7;
	date.setUTCDate(date.getUTCDate() - offset);
	return date.toISOString().slice(0, 10);
}

/** Découpe un texte long en morceaux, de préférence sur un saut de ligne. */
export function chunk(text: string, size = 4000): string[] {
	const chunks: string[] = [];
	let rest = text;
	while (rest.length > size) {
		let cut = rest.lastIndexOf("\n", size);
		if (cut < size / 2) cut = size;
		chunks.push(rest.slice(0, cut));
		rest = rest.slice(cut).replace(/^\n/, "");
	}
	if (rest) chunks.push(rest);
	return chunks;
}
