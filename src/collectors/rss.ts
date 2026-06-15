import RSSParser from 'rss-parser';

const parser = new RSSParser();

export const RSS_SOURCES = [
    { name: 'Dev.to', url: 'https://dev.to/feed' },
    { name: 'Smashing Magazine', url: 'https://www.smashingmagazine.com/feed/' },
    { name: 'CSS Tricks', url: 'https://css-tricks.com/feed/' },
    { name: 'Node Weekly', url: 'https://nodeweekly.com/rss/' },
    { name: 'Human Coders', url: 'https://news.humancoders.com/t/javascript.rss' },
    { name: 'Reddit r/webdev', url: 'https://www.reddit.com/r/webdev/.rss' },
    { name: 'Reddit r/javascript', url: 'https://www.reddit.com/r/javascript/.rss' },
    { name: 'Reddit r/reactjs', url: 'https://www.reddit.com/r/reactjs/.rss' },
    { name: 'Reddit r/typescript', url: 'https://www.reddit.com/r/typescript/.rss' },
];

export interface Article {
    title: string;
    url: string;
    source: string;
    content: string;
    published_at: string;
}

export async function fetchRSSFeeds(): Promise<Article[]> {
    const articles: Article[] = [];

    for (const source of RSS_SOURCES) {
        try {
            const feed = await parser.parseURL(source.url);
            for (const item of feed.items.slice(0, 5)) {
                articles.push({
                    title: item.title || 'Sans titre',
                    url: item.link || '',
                    source: source.name,
                    content: item.contentSnippet || item.content || '',
                    published_at: item.pubDate || new Date().toISOString(),
                });
            }
            console.log(`✅ ${source.name} — ${feed.items.length} articles récupérés`);
        } catch (err) {
            console.error(`❌ Erreur sur ${source.name}:`, err);
        }
    }

    return articles;
}