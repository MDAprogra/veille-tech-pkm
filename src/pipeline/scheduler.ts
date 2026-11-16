import type { RunResult } from "../db/store.js";
import { log } from "../logger.js";

export interface ActiveHours {
	start: number;
	end: number;
}

function parisParts(date: Date, timeZone: string) {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		weekday: "short",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		hourCycle: "h23",
	}).formatToParts(date);
	const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
	return {
		weekday: get("weekday"),
		day: `${get("year")}-${get("month")}-${get("day")}`,
		hour: Number(get("hour")),
	};
}

export function isActiveHour(date: Date, hours: ActiveHours, timeZone: string): boolean {
	const { hour } = parisParts(date, timeZone);
	return hours.start <= hours.end
		? hour >= hours.start && hour < hours.end
		: hour >= hours.start || hour < hours.end;
}

/** Retourne la date du jour (AAAA-MM-JJ) si on est lundi dans le fuseau donné, sinon null. */
export function mondayKey(date: Date, timeZone: string): string | null {
	const { weekday, day } = parisParts(date, timeZone);
	return weekday === "Mon" ? day : null;
}

export interface SchedulerOptions {
	intervalMinutes: number;
	activeHours: ActiveHours;
	timezone: string;
	run: () => Promise<RunResult>;
	/** Appelé après chaque collecte planifiée (ex. digest hebdomadaire). */
	afterRun?: () => Promise<void>;
	/** Date de la dernière collecte connue, pour ne pas recollecter à chaque redéploiement. */
	lastRunAt?: Date | null;
}

export class Scheduler {
	nextRunAt: Date | null = null;
	private running = false;
	private timer: NodeJS.Timeout | null = null;

	constructor(private readonly options: SchedulerOptions) {}

	get busy(): boolean {
		return this.running;
	}

	start(): void {
		const interval = this.options.intervalMinutes * 60_000;
		const last = this.options.lastRunAt?.getTime();
		const sinceLast = last ? Date.now() - last : Number.POSITIVE_INFINITY;
		this.schedule(sinceLast >= interval ? 2_000 : interval - sinceLast);
	}

	stop(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.nextRunAt = null;
	}

	/** Lance une collecte. `force` ignore la plage horaire (commande manuelle). */
	async trigger(force = false): Promise<RunResult | "busy" | "inactive"> {
		if (this.running) return "busy";
		if (!force && !isActiveHour(new Date(), this.options.activeHours, this.options.timezone)) {
			return "inactive";
		}
		this.running = true;
		try {
			return await this.options.run();
		} finally {
			this.running = false;
		}
	}

	private schedule(delayMs: number): void {
		this.nextRunAt = new Date(Date.now() + delayMs);
		this.timer = setTimeout(() => void this.tick(), delayMs);
	}

	private async tick(): Promise<void> {
		try {
			const outcome = await this.trigger();
			if (outcome === "inactive") log.info("😴 Hors plage horaire — collecte ignorée");
			else if (outcome !== "busy") await this.options.afterRun?.();
		} catch (err) {
			log.error("Erreur du planificateur", err);
		}
		if (this.timer) this.schedule(this.options.intervalMinutes * 60_000);
	}
}
