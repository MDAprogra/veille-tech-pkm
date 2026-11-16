export const CATEGORIES = ["web", "ia", "communaute", "infra"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Source {
	name: string;
	url: string;
	category: Category;
	lang: "fr" | "en";
	/** Nombre max d'articles pris par collecte (défaut : ITEMS_PER_SOURCE). */
	limit?: number;
}

/**
 * Sources d'origine. Elles servent uniquement à initialiser la table `sources` :
 * ensuite, les flux se gèrent depuis le tableau de bord, sans redéploiement.
 */
export const SOURCES: Source[] = [
	// Front / Web
	{ name: "Dev.to", url: "https://dev.to/feed", category: "web", lang: "en" },
	{
		name: "Smashing Magazine",
		url: "https://www.smashingmagazine.com/feed/",
		category: "web",
		lang: "en",
	},
	{ name: "web.dev (Google)", url: "https://web.dev/feed.xml", category: "web", lang: "en" },
	{
		name: "JavaScript Weekly",
		url: "https://javascriptweekly.com/rss/",
		category: "web",
		lang: "en",
	},
	{ name: "Frontend Focus", url: "https://frontendfoc.us/rss", category: "web", lang: "en" },
	{
		name: "This Week in React",
		url: "https://thisweekinreact.com/newsletter/rss.xml",
		category: "web",
		lang: "en",
	},
	{ name: "Node Weekly", url: "https://nodeweekly.com/rss/", category: "web", lang: "en" },
	{ name: "Deno Blog", url: "https://deno.com/feed", category: "web", lang: "en" },

	// IA / LLM
	{
		name: "arXiv cs.AI + cs.LG",
		url: "https://rss.arxiv.org/rss/cs.ai+cs.lg",
		category: "ia",
		lang: "en",
	},
	{ name: "arXiv cs.CL", url: "https://rss.arxiv.org/rss/cs.CL", category: "ia", lang: "en" },

	// Veille francophone / communauté
	{ name: "Korben", url: "https://korben.info/feed", category: "communaute", lang: "fr" },
	{
		name: "Alsacréations",
		url: "https://www.alsacreations.com/rss/actualites.xml",
		category: "communaute",
		lang: "fr",
	},
	{
		name: "Human Coders",
		url: "https://news.humancoders.com/t/javascript.rss",
		category: "communaute",
		lang: "fr",
	},
	{
		name: "Reddit r/webdev",
		url: "https://www.reddit.com/r/webdev/.rss",
		category: "communaute",
		lang: "en",
	},

	// Infra / sécurité
	{
		name: "Krebs on Security",
		url: "https://krebsonsecurity.com/feed/",
		category: "infra",
		lang: "en",
	},
	{ name: "The New Stack", url: "https://thenewstack.io/feed/", category: "infra", lang: "en" },
];

/** Taxonomie fermée : le LLM ne peut étiqueter qu'avec ces thèmes (issus de context.md). */
export const TAGS = [
	"frontend",
	"backend",
	"javascript",
	"typescript",
	"react",
	"css",
	"ia",
	"securite",
	"architecture",
	"performance",
	"accessibilite",
	"devops",
	"data",
	"outils",
] as const;

export type Tag = (typeof TAGS)[number];
