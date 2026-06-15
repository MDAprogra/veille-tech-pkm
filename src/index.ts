import { initDB, insertArticle } from './storage/database.js';
import { fetchRSSFeeds } from './collectors/rss.js';
import { summarizeArticle } from './processors/summarizer.js';
import { startBot, notifyNewArticles, updateCollectStats } from './bot/telegram.js';

function isActiveHours(): boolean {
    const now = new Date();
    const hour = now.toLocaleString('en-US', {
        timeZone: 'Europe/Paris',
        hour: 'numeric',
        hour12: false,
    });
    const h = parseInt(hour);
    return h >= 9 && h < 19;
}

async function collect() {
    if (!isActiveHours()) {
        console.log('😴 Hors plage horaire (19h-9h) — collecte ignorée.');
        return;
    }

    console.log('🔍 Démarrage de la collecte...');

    const [rssArticles] = await Promise.all([
        fetchRSSFeeds(),
    ]);

    const articles = [...rssArticles];
    const newArticles: any[] = [];
    let count = 0;

    for (const article of articles) {
        count++;
        console.log(`📝 Résumé (${count}/${articles.length}) : ${article.title}`);
        const summary = await summarizeArticle(article);
        const result = insertArticle({ ...article, summary });
        if (result.changes > 0) {
            newArticles.push({ ...article, summary });
        }
    }

    if (newArticles.length > 0) {
        console.log(`📲 Envoi de ${newArticles.length} notifications Telegram...`);
        await notifyNewArticles(newArticles);
    }

    updateCollectStats();
    console.log(`✅ Collecte terminée — ${articles.length} articles traités.`);
}

async function main() {
    initDB();
    startBot();
    await collect();

    setInterval(async () => {
        await collect();
    }, 2 * 60 * 60 * 1000);
}

main().catch(console.error);