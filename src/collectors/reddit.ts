export const REDDIT_SOURCES = [
  { name: 'Reddit r/webdev', subreddit: 'webdev' },
  { name: 'Reddit r/javascript', subreddit: 'javascript' },
  { name: 'Reddit r/node', subreddit: 'node' },
  { name: 'Reddit r/reactjs', subreddit: 'reactjs' },
  { name: 'Reddit r/typescript', subreddit: 'typescript' },
];

export interface Article {
  title: string;
  url: string;
  source: string;
  content: string;
  published_at: string;
}

export async function fetchRedditFeeds(): Promise<Article[]> {
  const articles: Article[] = [];

  for (const source of REDDIT_SOURCES) {
    try {
      const response = await fetch(
        `https://www.reddit.com/r/${source.subreddit}/hot.json?limit=5`,
        { headers: { 'User-Agent': 'veille-tech-pkm/1.0' } }
      );

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json() as any;
      const posts = data?.data?.children ?? [];

      for (const post of posts) {
        const p = post.data;
        if (p.stickied || p.is_video) continue;

        articles.push({
          title: p.title,
          url: p.url,
          source: source.name,
          content: p.selftext?.slice(0, 1000) || p.title,
          published_at: new Date(p.created_utc * 1000).toISOString(),
        });
      }

      console.log(`✅ ${source.name} — ${posts.length} posts récupérés`);
    } catch (err) {
      console.error(`❌ Erreur sur ${source.name}:`, err);
    }
  }

  return articles;
}