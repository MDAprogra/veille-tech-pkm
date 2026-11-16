import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Bot, type Context, InputFile } from "grammy";
import type { App } from "../app.js";
import type { Article, RunResult } from "../db/store.js";
import { log } from "../logger.js";
import { analyze } from "../services/analyze.js";
import { ask, formatAnswer } from "../services/ask.js";
import { chunk, exportCsv, exportMarkdown, frenchDate, stars } from "../services/format.js";
import { SOURCES, TAGS } from "../sources.js";

const COMMANDS = [
	["summary", "Derniers articles — /summary [thème]"],
	["top", "Meilleurs articles de la semaine — /top [jours]"],
	["search", "Recherche plein texte — /search mots-clés"],
	["ask", "Question sur la veille — /ask question"],
	["analyze", "Analyse des tendances — /analyze [jours]"],
	["export", "Export Markdown ou CSV — /export [csv] [score min]"],
	["collect", "Lancer une collecte maintenant"],
	["infos", "État du système"],
	["logs", "Derniers événements"],
] as const;

const NO_LLM = "⚠️ Aucun modèle d'IA configuré : cette commande est indisponible.";

export function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function articleHtml(a: Article, summaryLength = 600): string {
	const summary = a.summary ?? "Résumé indisponible";
	const short =
		summary.length > summaryLength ? `${summary.slice(0, summaryLength).trimEnd()}…` : summary;
	const tags = a.tags.length ? ` · ${a.tags.map((t) => `#${t}`).join(" ")}` : "";
	return [
		`${stars(a.score)} <b>${escapeHtml(a.title)}</b>`,
		`📰 ${escapeHtml(a.source)}${escapeHtml(tags)}`,
		`📝 ${escapeHtml(short)}`,
		`🔗 ${escapeHtml(a.url)}`,
	].join("\n");
}

/** Regroupe des blocs en messages ne dépassant pas la limite Telegram, sans couper un bloc. */
export function pack(blocks: string[], size = 3800): string[] {
	const messages: string[] = [];
	let current = "";
	for (const block of blocks) {
		if (current && current.length + block.length + 2 > size) {
			messages.push(current);
			current = "";
		}
		current = current ? `${current}\n\n${block}` : block;
	}
	if (current) messages.push(current);
	return messages;
}

export function runSummary(result: RunResult): string {
	const lines = [
		`✅ Collecte terminée`,
		`• ${result.fetched} articles lus, ${result.inserted} nouveaux`,
		`• ${result.enriched} résumés, ${result.failed} échecs`,
		`• ${result.notified} notifiés`,
	];
	if (result.sources_failed.length)
		lines.push(`• Sources KO : ${result.sources_failed.join(", ")}`);
	if (result.error) lines.push(`❌ ${result.error}`);
	return lines.join("\n");
}

export interface TelegramInterface {
	start(): void;
	stop(): Promise<void>;
	notify(articles: Article[]): Promise<void>;
	sendText(text: string): Promise<void>;
}

export function createTelegram(app: App, token: string): TelegramInterface {
	const { config, store } = app;
	const bot = new Bot(token);
	const ownerChat = config.telegram.chatId;
	const restricted = Boolean(ownerChat) && !config.telegram.public;

	const sendHtml = async (ctx: Context, blocks: string[]) => {
		for (const message of pack(blocks)) {
			await ctx.reply(message, {
				parse_mode: "HTML",
				link_preview_options: { is_disabled: true },
			});
		}
	};
	// Les réponses du LLM contiennent du Markdown libre : envoi en texte brut pour ne jamais casser le parseur Telegram.
	const sendPlain = async (ctx: Context, text: string) => {
		for (const part of chunk(text)) {
			await ctx.reply(part, { link_preview_options: { is_disabled: true } });
		}
	};
	const arg = (ctx: Context) => (typeof ctx.match === "string" ? ctx.match.trim() : "");

	// Le bot consomme des crédits Mistral/Tavily : par défaut, seul le propriétaire y a accès.
	bot.use(async (ctx, next) => {
		if (restricted && String(ctx.chat?.id) !== ownerChat) {
			log.warn(`Accès refusé au chat ${ctx.chat?.id}`);
			return;
		}
		await next();
	});

	bot.command(["start", "help"], async (ctx) => {
		const lines = COMMANDS.map(([name, description]) => `/${name} — ${description}`);
		await ctx.reply(
			`👋 Bot de veille technologique\n\n${lines.join("\n")}\n\nThèmes : ${TAGS.join(", ")}\nID de ce chat : ${ctx.chat.id}`,
		);
	});

	bot.command("summary", async (ctx) => {
		const term = arg(ctx).toLowerCase();
		const isTag = (TAGS as readonly string[]).includes(term);
		const articles = !term
			? store.list({ limit: 5 })
			: isTag
				? store.list({ tag: term, limit: 5 })
				: store.search(term, { limit: 5 });
		if (articles.length === 0) {
			await ctx.reply(term ? `📭 Aucun article pour « ${term} ».` : "📭 Aucun article collecté.");
			return;
		}
		await sendHtml(
			ctx,
			articles.map((a) => articleHtml(a)),
		);
	});

	bot.command("top", async (ctx) => {
		const days = Number.parseInt(arg(ctx), 10) || 7;
		const articles = store.top({ days, limit: 8 });
		if (articles.length === 0) {
			await ctx.reply(`📭 Aucun article sur les ${days} derniers jours.`);
			return;
		}
		await sendHtml(ctx, [
			`🏆 <b>Top des ${days} derniers jours</b>`,
			...articles.map((a) => articleHtml(a, 300)),
		]);
	});

	bot.command("search", async (ctx) => {
		const query = arg(ctx);
		if (!query) {
			await ctx.reply("Usage : /search mots-clés");
			return;
		}
		const articles = store.search(query, { limit: 8 });
		if (articles.length === 0) {
			await ctx.reply(`📭 Aucun résultat pour « ${query} ».`);
			return;
		}
		await sendHtml(
			ctx,
			articles.map((a) => articleHtml(a, 300)),
		);
	});

	bot.command("ask", async (ctx) => {
		const question = arg(ctx);
		if (!question) {
			await ctx.reply("Usage : /ask ta question");
			return;
		}
		if (!app.llm) {
			await ctx.reply(NO_LLM);
			return;
		}
		await ctx.replyWithChatAction("typing");
		const answer = await ask(question, { store, llm: app.llm, webSearch: app.webSearch });
		await sendPlain(ctx, formatAnswer(answer));
	});

	bot.command("analyze", async (ctx) => {
		if (!app.llm) {
			await ctx.reply(NO_LLM);
			return;
		}
		const days = Number.parseInt(arg(ctx), 10) || undefined;
		await ctx.replyWithChatAction("typing");
		const report = await analyze({ store, llm: app.llm }, { days });
		await sendPlain(
			ctx,
			report
				? `📊 Analyse de ta veille${days ? ` — ${days} derniers jours` : ""}\n\n${report}`
				: "📭 Aucun article à analyser.",
		);
	});

	bot.command("export", async (ctx) => {
		const args = arg(ctx).toLowerCase().split(/\s+/).filter(Boolean);
		const csv = args.includes("csv");
		const minScore = Number(args.find((a) => /^[1-5]$/.test(a))) || undefined;
		const articles = store.list({ minScore });
		if (articles.length === 0) {
			await ctx.reply("📭 Aucun article à exporter.");
			return;
		}
		const date = new Date().toISOString().slice(0, 10);
		const filename = `veille_export_${date}.${csv ? "csv" : "md"}`;
		const content = csv ? exportCsv(articles) : exportMarkdown(articles);

		// Copie sur le volume persistant ; un échec d'écriture ne doit pas empêcher l'envoi.
		const dir = config.exportDir ?? dirname(config.db.path);
		try {
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, filename), content);
		} catch (err) {
			log.error(`Export non sauvegardé dans ${dir}`, err);
		}

		await ctx.replyWithDocument(new InputFile(Buffer.from(content), filename), {
			caption: `${articles.length} articles${minScore ? ` (score ≥ ${minScore})` : ""}`,
		});
		log.info(`📤 Export ${filename} (${articles.length} articles)`);
	});

	bot.command("collect", async (ctx) => {
		if (app.scheduler.busy) {
			await ctx.reply("⏳ Une collecte est déjà en cours.");
			return;
		}
		await ctx.reply("🔍 Collecte lancée, je te préviens à la fin.");
		const chatId = ctx.chat.id;
		// Non attendu : une collecte dure plusieurs minutes et bloquerait les autres commandes.
		void app.scheduler
			.trigger(true)
			.then((result) =>
				bot.api.sendMessage(
					chatId,
					typeof result === "string" ? "⏳ Déjà en cours." : runSummary(result),
				),
			)
			.catch((err) => log.error("Collecte manuelle en échec", err));
	});

	bot.command("infos", async (ctx) => {
		const stats = store.stats();
		const [lastRun] = store.runs(1);
		const next = app.scheduler.nextRunAt;
		const fmt = (d: Date) => d.toLocaleString("fr-FR", { timeZone: config.pipeline.timezone });
		const { start, end } = config.pipeline.activeHours;
		const topTags = Object.entries(stats.byTag)
			.slice(0, 5)
			.map(([tag, n]) => `${tag} (${n})`)
			.join(", ");
		await ctx.reply(
			[
				"ℹ️ PKM Veille Tech",
				"",
				"📚 Base",
				`├ Articles résumés : ${stats.total}`,
				`├ En attente : ${stats.pending} · en échec : ${stats.failed}`,
				`├ Score moyen : ${stats.averageScore ?? "—"}/5`,
				`└ Thèmes dominants : ${topTags || "—"}`,
				"",
				"⏱️ Collecte",
				`├ Effectuées : ${store.runCount()}`,
				`├ Dernière : ${lastRun ? `${frenchDate(lastRun.started_at)} — ${lastRun.inserted} nouveaux` : "aucune"}`,
				`├ Prochaine : ${app.scheduler.busy ? "en cours" : next ? fmt(next) : "—"}`,
				`└ Toutes les ${config.pipeline.intervalMinutes} min, ${start}h–${end}h (Paris)`,
				"",
				"📡 Système",
				`├ Sources : ${SOURCES.length}`,
				`├ IA : ${app.llmLabel ?? "non configurée"}`,
				`├ Recherche web : ${app.webSearch ? "Tavily" : "désactivée"}`,
				`└ En ligne depuis : ${fmt(app.startedAt)}`,
			].join("\n"),
		);
	});

	bot.command("logs", async (ctx) => {
		const runs = store.runs(5).map((r) => {
			const status = r.error ? "❌" : r.finished_at ? "✅" : "⏳";
			return `${status} ${r.started_at} UTC — ${r.inserted} nouveaux, ${r.enriched} résumés, ${r.failed} échecs`;
		});
		const events = log.recent(15);
		await sendPlain(
			ctx,
			[
				"📋 Dernières collectes",
				...(runs.length ? runs : ["(aucune)"]),
				"",
				"🧾 Événements récents",
				...(events.length ? events : ["(aucun)"]),
			].join("\n"),
		);
	});

	bot.catch(async ({ ctx, error }) => {
		log.error(`Commande en échec (${ctx.message?.text?.split(" ")[0] ?? "?"})`, error);
		await ctx.reply("❌ Une erreur est survenue. Détail dans /logs.").catch(() => {});
	});

	async function sendToOwner(messages: string[], html: boolean): Promise<void> {
		if (!ownerChat) return;
		for (const message of messages) {
			await bot.api.sendMessage(ownerChat, message, {
				parse_mode: html ? "HTML" : undefined,
				link_preview_options: { is_disabled: true },
			});
		}
	}

	return {
		start() {
			void bot.api
				.setMyCommands(COMMANDS.map(([command, description]) => ({ command, description })))
				.catch((err) => log.error("Menu des commandes non enregistré", err));
			void bot
				.start({ onStart: (me) => log.info(`🤖 Bot Telegram démarré (@${me.username})`) })
				.catch((err) => log.error("Bot Telegram arrêté", err));
		},
		stop: () => bot.stop(),
		async notify(articles) {
			const bySource = new Map<string, Article[]>();
			for (const a of articles) bySource.set(a.source, [...(bySource.get(a.source) ?? []), a]);
			const blocks: string[] = [];
			for (const [source, items] of bySource) {
				blocks.push(`🆕 <b>${escapeHtml(source)}</b> — ${items.length} article(s)`);
				blocks.push(...items.map((a) => articleHtml(a, 280)));
			}
			await sendToOwner(pack(blocks), true);
		},
		sendText: (text) => sendToOwner(chunk(text), false),
	};
}
