import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config/index.js';
import { exportAllArticles, getRecentArticles, searchArticles } from '../storage/database.js';
import { tavily } from '@tavily/core';
import { Mistral } from '@mistralai/mistralai';
import { writeFileSync } from 'fs';


const bot = new TelegramBot(config.telegram.token, { polling: true });
const tavilyClient = tavily({ apiKey: config.tavily.apiKey });
const mistralClient = new Mistral({ apiKey: config.mistral.apiKey });

export function startBot() {
    console.log('🤖 Bot Telegram démarré...');

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

        await bot.sendMessage(msg.chat.id, '🔍 Recherche en cours...');

        // 1. Cherche dans la base locale
        const localArticles = searchArticles(question) as any[];
        let context = '';

        if (localArticles.length > 0) {
            context += `📚 Articles de ta veille :\n`;
            context += localArticles.map(a =>
                `- ${a.title} (${a.source})\n  ${a.summary}`
            ).join('\n');
        }

        // 2. Fallback web si peu de résultats locaux
        if (localArticles.length < 2) {
            try {
                const webResults = await tavilyClient.search(question, {
                    maxResults: 3,
                    searchDepth: 'basic',
                });
                if (webResults.results.length > 0) {
                    context += `\n\n🌐 Résultats web :\n`;
                    context += webResults.results.map(r =>
                        `- ${r.title}\n  ${r.content?.slice(0, 300)}`
                    ).join('\n');
                }
            } catch (err) {
                console.error('❌ Erreur Tavily:', err);
            }
        }

        // 3. Synthèse Mistral
        try {
            const result = await mistralClient.chat.complete({
                model: 'mistral-small-latest',
                messages: [{
                    role: 'user',
                    content: `Tu es un assistant de veille technologique Full Stack.
Nous sommes en 2026. Réponds uniquement avec des informations actuelles (2026) ou très récentes.
Pour les tendances, concentre-toi sur l'état actuel en 2026 et les perspectives 2027.
Ignore toute information antérieure à 2025 sauf si elle est encore pertinente aujourd'hui.

Question : ${question}

Contexte disponible :
${context}

Réponds en français de manière concise et structurée.
Si le contexte est insuffisant, dis-le clairement mais reste focalisé sur 2026.`
                }]
            });

            const answer = result.choices?.[0]?.message?.content as string ?? 'Réponse indisponible.';
            await bot.sendMessage(msg.chat.id, `💡 ${answer}`);
        } catch (err) {
            console.error('❌ Erreur Mistral:', err);
            await bot.sendMessage(msg.chat.id, '❌ Erreur lors de la génération de la réponse.');
        }
    });

    bot.onText(/\/export/, async (msg) => {
        await bot.sendMessage(msg.chat.id, '⏳ Génération de l\'export en cours...');

        const articles = exportAllArticles() as any[];

        if (articles.length === 0) {
            await bot.sendMessage(msg.chat.id, '📭 Aucun article à exporter.');
            return;
        }

        const date = new Date().toISOString().split('T')[0];
        let content = `# Export Veille Technologique — ${date}\n\n`;
        content += `> ${articles.length} articles collectés\n\n---\n\n`;

        for (const a of articles) {
            content += `## ${a.title}\n\n`;
            content += `- **Source** : ${a.source}\n`;
            content += `- **Date** : ${a.published_at}\n`;
            content += `- **Lien** : ${a.url}\n\n`;
            content += `**Résumé** : ${a.summary}\n\n`;
            content += `---\n\n`;
        }

        const filename = `/data/veille_export_${date}.md`;
        writeFileSync(filename, content);

        await bot.sendDocument(msg.chat.id, Buffer.from(content), {}, {
            filename: `veille_export_${date}.md`,
            contentType: 'text/markdown',
        });

        console.log(`📤 Export généré : ${filename} (${articles.length} articles)`);
    });
}

export async function notifyNewArticles(articles: any[]) {
    for (const a of articles) {
        const message = `🆕 Nouvel article !\n\n📌 ${a.title}\n📰 ${a.source}\n📝 ${a.summary ?? 'Résumé indisponible'}\n🔗 ${a.url}`;
        await bot.sendMessage(config.telegram.chatId, message).catch(console.error);
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}