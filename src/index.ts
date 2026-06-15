import { initDB, insertArticle } from './storage/database.js';
import { fetchRSSFeeds } from './collectors/rss.js';
import { summarizeArticle } from './processors/summarizer.js';
import { startBot } from './bot/telegram.js';
import { notifyNewArticles } from './bot/telegram.js';


async function collect() {
    console.log('🔍 Démarrage de la collecte...');
    const articles = await fetchRSSFeeds();
    const newArticles: any[] = [];

    for (const article of articles) {
        console.log(`📝 Résumé (${articles.indexOf(article) + 1}/${articles.length}) : ${article.title}`); const summary = await summarizeArticle(article);
        const result = insertArticle({ ...article, summary });
        if (result.changes > 0) {
            newArticles.push({ ...article, summary });
        }
    }

    if (newArticles.length > 0) {
        console.log(`📲 Envoi de ${newArticles.length} notifications Telegram...`);
        await notifyNewArticles(newArticles);
    }

    console.log(`✅ Collecte terminée — ${articles.length} articles traités.`);
}

async function main() {
    initDB();
    startBot();
    await collect();

    // Collecte toutes les 2 heures
    setInterval(async () => {
        await collect();
    }, 2 * 60 * 60 * 1000);
}

main().catch(console.error);