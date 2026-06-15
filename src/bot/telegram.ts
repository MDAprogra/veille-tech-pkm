import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config/index.js';
import { getRecentArticles } from '../storage/database.js';

const bot = new TelegramBot(config.telegram.token, { polling: true });

export function startBot() {
    console.log('🤖 Bot Telegram démarré...');
    bot.on('message', (msg) => {
        console.log('Chat ID:', msg.chat.id);
    });

    bot.onText(/\/start/, (msg) => {
        bot.sendMessage(msg.chat.id, `👋 Bienvenue sur ton bot de veille technologique !\n\nCommandes disponibles :\n/summary — Les 5 derniers articles résumés\n/ask [question] — Pose une question sur ta base de veille`);
    });

    bot.onText(/\/summary/, (msg) => {
        const articles = getRecentArticles(5) as any[];

        if (articles.length === 0) {
            bot.sendMessage(msg.chat.id, '📭 Aucun article collecté pour le moment.');
            return;
        }

        for (const a of articles) {
            const message = `📌 ${a.title}\n📰 ${a.source}\n📝 ${a.summary ?? 'Résumé indisponible'}\n🔗 ${a.url}`;
            bot.sendMessage(msg.chat.id, message).catch(console.error);
        }
    });

    bot.onText(/\/ask (.+)/, async (msg, match) => {
        const question = match?.[1];
        if (!question) return;
        bot.sendMessage(msg.chat.id, '🚧 Fonctionnalité /ask en cours de développement.');
    });
}

export async function notifyNewArticles(articles: any[]) {
    for (const a of articles) {
        const message = `🆕 Nouvel article !\n\n📌 ${a.title}\n📰 ${a.source}\n📝 ${a.summary ?? 'Résumé indisponible'}\n🔗 ${a.url}`;
        await bot.sendMessage(config.telegram.chatId, message).catch(console.error);
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}