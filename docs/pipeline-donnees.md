# Pipeline de données — Veille technologique

## Vue d'ensemble
Sources RSS (13) → Collecte → Résumé Mistral AI → Scoring → SQLite → Bot Telegram

## Sources de données

### Source 1 — Flux RSS (13 sources)

| Source | URL | Thématique |
|---|---|---|
| Dev.to | https://dev.to/feed | Développement général |
| Smashing Magazine | https://www.smashingmagazine.com/feed/ | Front-end, UX |
| CSS Tricks | https://css-tricks.com/feed/ | CSS, front-end |
| Node Weekly | https://nodeweekly.com/rss/ | Node.js |
| Human Coders | https://news.humancoders.com/t/javascript.rss | JavaScript |
| Reddit r/webdev | https://www.reddit.com/r/webdev/.rss | Web dev communauté |
| JavaScript Weekly | https://javascriptweekly.com/rss/ | JavaScript |
| Frontend Focus | https://frontendfoc.us/rss | Front-end |
| This Week in React | https://thisweekinreact.com/newsletter/rss.xml | React |
| web.dev (Google) | https://web.dev/feed.xml | Web platform |
| Deno Blog | https://deno.com/feed | Deno, runtime JS |
| Korben | https://korben.info/feed | Tech généraliste 🇫🇷 |
| Alsacréations | https://www.alsacreations.com/rss/actualites.xml | Web, standards 🇫🇷 |

**Fréquence de collecte** : toutes les 2h, plage horaire 9h–19h (Europe/Paris)  
**Volume par collecte** : 5 articles maximum par source, soit ~65 articles par cycle

## Étapes du pipeline

### Étape 1 — Collecte RSS (`src/collectors/rss.ts`)

- Parsing des flux via `rss-parser`
- Extraction des champs : `title`, `url`, `source`, `content`, `published_at`
- Limitation à 5 articles par source pour maîtriser le volume
- Délai de 1s entre chaque source pour éviter le rate limiting
- Gestion des erreurs par source (une source en échec n'interrompt pas le pipeline)

**Format de sortie :**
```typescript
interface Article {
    title: string;
    url: string;
    source: string;
    content: string;
    published_at: string;
}
```

### Étape 2 — Résumé et scoring IA (`src/processors/summarizer.ts`)

- Appel à **Mistral AI** (`mistral-small-latest`) 🇫🇷
- Prompt structuré demandant un JSON `{ summary, score }`
- Score de pertinence 1–5 pour un développeur Full Stack junior/mid
- Retry automatique x3 en cas de rate limit HTTP 429 (attente 60s)
- Délai de 1s entre chaque article

**Grille de scoring :**

| Score | Signification |
|---|---|
| 5 | Indispensable (React/Node/TS majeur, sécurité critique) |
| 4 | Très pertinent (bonne pratique, outil utile) |
| 3 | Intéressant (culture tech, contexte général) |
| 2 | Peu pertinent (trop spécialisé ou hors scope) |
| 1 | Non pertinent (hors sujet complet) |

### Étape 3 — Stockage (`src/storage/database.ts`)

- Base de données **SQLite** via `better-sqlite3`
- Insertion avec `INSERT OR IGNORE` — pas de doublon sur l'URL
- Volume persistant Fly.io (`/data/veille.db`)

**Schéma de la table `articles` :**

```sql
CREATE TABLE IF NOT EXISTS articles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    url         TEXT UNIQUE NOT NULL,
    source      TEXT,
    summary     TEXT,
    content     TEXT,
    published_at TEXT,
    score       INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now'))
);
```

### Étape 4 — Notification (`src/bot/telegram.ts`)

- Filtrage : seuls les articles avec **score ≥ 4** sont notifiés
- Regroupement par source dans les messages Telegram
- Découpage automatique des messages > 4000 caractères (limite Telegram)
- Délai de 500ms entre chaque message pour éviter le flood

## Contrôles qualité

| Contrôle | Mécanisme |
|---|---|
| Doublons | `UNIQUE` sur `url` + `INSERT OR IGNORE` |
| Sources en échec | Try/catch par source, pipeline non interrompu |
| Rate limit Mistral | Retry x3 avec backoff 60s |
| Rate limit Reddit | Gestion HTTP 429 loggée |
| Plage horaire | Collecte inactive entre 19h et 9h (Paris) |
| Volume messages | Chunking automatique à 4000 caractères |

## Types métier

```typescript
// Article brut collecté depuis RSS
interface Article {
    title: string;
    url: string;
    source: string;
    content: string;
    published_at: string;
}

// Article enrichi par le pipeline (après résumé + scoring)
type EnrichedArticle = Omit<StoredArticle, "id" | "created_at">;

// Article stocké en base (avec métadonnées SQLite)
interface StoredArticle {
    id: number;
    title: string;
    url: string;
    source: string;
    summary: string;
    content: string;
    published_at: string;
    score: number;
    created_at: string;
}
```

## Métriques observées en production

- Articles traités par collecte : ~57–65
- Nouveaux articles par collecte : variable selon l'activité des sources
- Articles notifiés (score ≥ 4) : ~20–30% du total
- Durée d'une collecte complète : ~3–4 minutes
- Uptime : Fly.io Paris (cdg) 🇫🇷, volume persistant 1GB

## Conformité RGPD

Les données collectées sont exclusivement des **contenus publics** (titres, URLs, extraits d'articles publiquement accessibles). Aucune donnée personnelle n'est collectée, stockée ou traitée. Aucun consentement utilisateur n'est requis pour ce pipeline.