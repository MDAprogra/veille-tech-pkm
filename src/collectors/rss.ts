import RSSParser from "rss-parser";

const parser = new RSSParser();

export const RSS_SOURCES = [
	// Front / Web
	{ name: "Dev.to", url: "https://dev.to/feed" },
	{ name: "Smashing Magazine", url: "https://www.smashingmagazine.com/feed/" },
	{ name: "web.dev (Google)", url: "https://web.dev/feed.xml" },
	{ name: "JavaScript Weekly", url: "https://javascriptweekly.com/rss/" },
	{ name: "Frontend Focus", url: "https://frontendfoc.us/rss" },
	{ name: "This Week in React", url: "https://thisweekinreact.com/newsletter/rss.xml" },
	{ name: "Node Weekly", url: "https://nodeweekly.com/rss/" },
	{ name: "Deno Blog", url: "https://deno.com/feed" },

	// IA / LLM
	{ name: "arXiv cs.AI + cs.LG", url: "https://rss.arxiv.org/rss/cs.ai+cs.lg" },
	{ name: "arXiv cs.CL", url: "https://rss.arxiv.org/rss/cs.CL" },

	// Veille francophone / communauté
	{ name: "Korben", url: "https://korben.info/feed" },
	{ name: "Alsacréations", url: "https://www.alsacreations.com/rss/actualites.xml" },
	{ name: "Human Coders", url: "https://news.humancoders.com/t/javascript.rss" },
	{ name: "Reddit r/webdev", url: "https://www.reddit.com/r/webdev/.rss" },

	// Infra / sécurité
	{ name: "Krebs on Security", url: "https://krebsonsecurity.com/feed/" },
	{ name: "The New Stack", url: "https://thenewstack.io/feed/" },
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
					title: item.title || "Sans titre",
					url: item.link || "",
					source: source.name,
					content: item.contentSnippet || item.content || "",
					published_at: item.pubDate || new Date().toISOString(),
				});
			}
			console.log(`✅ ${source.name} — ${feed.items.length} articles récupérés`);
		} catch (err) {
			console.error(`❌ Erreur sur ${source.name}:`, err);
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}

	return articles;
}
