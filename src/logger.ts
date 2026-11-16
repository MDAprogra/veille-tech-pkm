const MAX_EVENTS = 100;
const events: string[] = [];

function stamp(): string {
	return new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
}

function record(line: string) {
	events.unshift(`[${stamp()}] ${line}`);
	if (events.length > MAX_EVENTS) events.pop();
}

export const log = {
	info(message: string) {
		console.log(message);
		record(message);
	},
	warn(message: string) {
		console.warn(`⚠️ ${message}`);
		record(`⚠️ ${message}`);
	},
	error(message: string, err?: unknown) {
		const detail = err instanceof Error ? err.message : err ? String(err) : "";
		console.error(`❌ ${message}${detail ? ` — ${detail}` : ""}`);
		record(`❌ ${message}${detail ? ` — ${detail}` : ""}`);
	},
	/** Derniers événements, du plus récent au plus ancien (perdus au redémarrage). */
	recent(limit = 20): string[] {
		return events.slice(0, limit);
	},
};
