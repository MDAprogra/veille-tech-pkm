# PKM Veille Technologique

**Auteur** : Matthias Dauvel
**Projet** : E1 — Veille Technologique (Master IRIS, RNCP Niveau 7)
**Déploiement** : https://veille-tech-dauvel.fly.dev

Système de **PKM (Personal Knowledge Management)** automatisé : il collecte des articles techniques (développement web Full Stack, IA, sécurité), les résume, les note et les étiquette avec Mistral AI, les stocke dans SQLite, puis les rend consultables par un bot Telegram, une API REST, un tableau de bord web et un serveur MCP (pour Claude).

---

## 1. Architecture

```
Flux RSS ─────► Collecte ──► Déduplication ──► Mistral AI 🇫🇷 ──► SQLite + index FTS5
 (toutes les 2 h,            (seuls les          (résumé FR,        (volume Fly.io)
  9 h–19 h Paris)             nouveaux)           score 1-5, thèmes)      │
                                                                         ▼
                    ┌──────────────┬───────────────┬──────────────┬─────────────┐
                    │ Bot Telegram │ API REST      │ Tableau de   │ Serveur MCP │
                    │ + notifs     │ /api/*        │ bord  /      │ /mcp        │
                    └──────────────┴───────────────┴──────────────┴─────────────┘
```

Un seul processus Node.js, hébergé sur **Fly.io (Paris, cdg)**.

| Composant | Technologie | Justification |
|---|---|---|
| Runtime | Node.js 22 + TypeScript strict | Typage fort, écosystème riche |
| Collecte | rss-parser | Léger, flux lus en parallèle (4 à la fois) |
| IA | Mistral AI (`mistral-small-latest`, mode JSON) ou tout fournisseur compatible OpenAI | Souveraineté française 🇫🇷, sans dépendre d'un seul fournisseur |
| Stockage | SQLite (better-sqlite3) + FTS5 | Zéro serveur, recherche plein texte intégrée |
| Bot | grammY (long polling) | Typé, maintenu, sans webhook à exposer |
| API / MCP | Express 5 + SDK MCP officiel | Un seul port pour tout |
| Recherche web | Tavily (optionnelle) | Complément de `/ask` quand la veille est mince |
| Qualité | Biome, `tsc`, tests `node:test` | Exécutés en CI avant tout déploiement |

---

## 2. Fonctionnement du pipeline

À chaque collecte (`src/pipeline/run.ts`) :

1. **Lecture des flux** — 5 articles max par source ; une source en panne n'interrompt pas les autres.
2. **Déduplication avant tout appel IA** — les URL sont nettoyées (paramètres `utm_*`, ancre) et seuls les articles inconnus sont insérés, avec le statut `pending`.
3. **Enrichissement** — pour chaque article en file, Mistral renvoie un JSON validé : résumé en français, score de pertinence 1-5, 1 à 3 thèmes pris dans une liste fermée (`src/sources.ts`).
   **Doublons de sujet** : si d'autres sources ont publié un article proche dans les 5 derniers jours, ils sont soumis au modèle dans le même appel ; s'il confirme qu'il s'agit de la même annonce, l'article est rattaché au premier. Il disparaît des listes et n'est pas notifié, et l'article principal affiche « couvert par N sources ».
4. **Reprise sur erreur** — une réponse inexploitable marque l'article `failed`, retenté aux collectes suivantes (3 essais max). Une panne de Mistral (quota, clé, réseau) interrompt l'enrichissement sans pénaliser les articles : ils restent en file.
5. **Notification** — les articles de score ≥ 4 jamais notifiés partent sur Telegram, regroupés par source.
6. **Historique** — chaque collecte est enregistrée dans la table `runs` avec ses compteurs et les tokens consommés (visible dans `/infos`, `/logs`, la page Système).

Les **sources** sont en base : elles s'ajoutent, se désactivent et se suppriment depuis le tableau de bord, sans redéploiement. L'état de chaque flux (dernière lecture réussie, erreurs consécutives) est suivi à chaque collecte.

**Propositions de sources par l'IA** (`src/services/sources.ts`) : le modèle propose des flux d'après les sources suivies et les thèmes peu couverts ; chaque flux est ensuite réellement lu (il doit exister, contenir des articles et être actif depuis moins de 45 jours), puis le modèle le note d'après ses vrais derniers titres. Les flux retenus attendent une validation humaine : aucun n'est collecté sans accord.

**Coût de l'IA** : les tokens de chaque appel sont enregistrés par jour et par usage (résumés, questions, analyses, propositions de sources). Le coût est estimé avec `LLM_PRICE_INPUT` et `LLM_PRICE_OUTPUT` (dollars par million de tokens).

Chaque lundi, après la première collecte, un **digest hebdomadaire** (analyse des 7 derniers jours) est envoyé sur Telegram.

Détails : [docs/pipeline-donnees.md](docs/pipeline-donnees.md) · [docs/database.md](docs/database.md)

---

## 3. Bot Telegram

| Commande | Effet |
|---|---|
| `/summary [thème ou mots]` | 5 derniers articles, éventuellement filtrés (`/summary react`) |
| `/favoris` | Articles marqués comme favoris depuis le tableau de bord |
| `/top [jours]` | Meilleurs articles de la période (7 jours par défaut) |
| `/search mots-clés` | Recherche plein texte classée par pertinence |
| `/ask question` | Réponse RAG : recherche dans la veille, complément web si moins de 2 résultats, synthèse Mistral avec sources citées |
| `/analyze [jours]` | Tendances, sources utiles, lacunes, recommandations |
| `/export [csv] [score min]` | Fichier Markdown (ou CSV) de la veille, aussi copié sur le volume |
| `/collect` | Lance une collecte immédiatement |
| `/infos`, `/logs` | État du système, dernières collectes et événements |

Par défaut, **seul le chat `TELEGRAM_CHAT_ID` peut utiliser le bot** (il consomme des crédits Mistral et Tavily). `TELEGRAM_PUBLIC=true` l'ouvre à tous.

---

## 4. API REST et tableau de bord

Toutes les routes `/api/*` exigent `Authorization: Bearer <DASHBOARD_TOKEN>`.

| Route | Description |
|---|---|
| `GET /health` | Sonde de santé (publique) |
| `GET /` | Tableau de bord web (demande le jeton) |
| `GET /api/articles` | Articles résumés. Filtres : `q`, `tag`, `source`, `min_score`, `days`, `favorite`, `unread`, `dismissed`, `limit`, `offset`. L'en-tête `X-Total-Count` donne le total pour la pagination |
| `GET /api/articles/:id` | Fiche : article, autres sources du même sujet, articles proches |
| `PATCH /api/articles/:id` | Actions : `{ "favorite": true, "read": true, "dismissed": false }` |
| `GET /api/trends?weeks=12` | Articles par thème et par semaine |
| `GET/POST /api/reports`, `GET/DELETE /api/reports/:id` | Rapports de tendances générés par l'IA, archivés en Markdown |
| `GET/POST /api/sources`, `PATCH/DELETE /api/sources/:id` | Gestion des sources (le flux est vérifié à l'ajout) |
| `POST /api/sources/suggest` | Lance une recherche de nouvelles sources par l'IA (tâche de fond) |
| `GET /api/system` | État du système : collectes, sources, consommation de l'IA, événements |
| `GET /api/articles/recent?limit=10` | Derniers articles |
| `GET /api/articles/search?q=…` | Recherche plein texte |
| `GET /api/stats` | Volumes, score moyen, répartition par source, thème, score, semaine, coût de l'IA |
| `GET /api/runs` | Historique des collectes |
| `GET /api/export.md`, `/api/export.csv` | Exports (mêmes filtres) |
| `POST /api/collect` | Lance une collecte |

---

### Tableau de bord

| Onglet | Contenu |
|---|---|
| **Articles** | Liste paginée, recherche, filtres (thème, source, score, favoris, non lus), exports. Un clic sur un titre ouvre la fiche : résumé, actions (favori, lu, pas pertinent), autres sources du même sujet, articles proches |
| **Tendances** | Un graphique par thème, semaine par semaine, à échelle commune, avec la tendance récente ; répartition par source et par score |
| **Rapport** | Génération d'une analyse de tendances sur une période choisie, archivage, export Markdown |
| **Sources** | Ajout d'un flux (ou d'un site, dont le flux est recherché), activation, suppression, état de santé, propositions de l'IA à valider |
| **Système** | Coût et consommation de l'IA, historique des collectes, configuration, événements récents |

## 5. Serveur MCP (Claude)

Endpoint Streamable HTTP sans état : `POST /mcp`. Outils : `search_articles`, `get_recent_articles`, `get_stats`, `export_all`, `get_timeline`.

Si `MCP_TOKEN` est défini, il est exigé soit en en-tête `Authorization: Bearer …`, soit dans l'URL pour les clients qui ne permettent pas d'en-tête personnalisé : `https://veille-tech-dauvel.fly.dev/mcp/<MCP_TOKEN>`. **Sans `MCP_TOKEN`, l'endpoint est public.**

Le fichier [context.md](context.md) cadre l'usage de la veille par Claude pour rédiger la note E1.

---

## 6. Installation

```bash
npm ci
cp .env.example .env      # renseigner les clés
npm run dev               # démarrage avec rechargement
npm run check             # lint + types + tests
```

### Fournisseur d'IA

Par défaut, l'outil appelle Mistral (`MISTRAL_API_KEY`). Pour passer par un autre fournisseur compatible OpenAI (Eden AI, Scaleway, OVHcloud AI Endpoints, EUrouter…), définir les trois variables suivantes ; elles sont alors prioritaires sur Mistral :

```bash
LLM_BASE_URL=https://api.edenai.run/v3   # ou https://api.scaleway.ai/v1, etc.
LLM_API_KEY=…
LLM_MODEL=…                              # identifiant exact du modèle chez ce fournisseur
```

Pour conserver l'argument de souveraineté, choisir un modèle européen (Mistral) et, chez un routeur comme Eden AI, désactiver les bascules automatiques vers des fournisseurs américains.

Variables d'environnement : voir [.env.example](.env.example). Aucune n'est obligatoire pour démarrer : chaque fonction absente (bot, IA, API) est désactivée avec un avertissement dans les logs.

`npm run requeue` remet en file d'enrichissement les articles sans thème ni score (historique antérieur à la v2) ; ils sont retraités au fil des collectes.

### Structure

```
src/
├── index.ts              Assemblage et démarrage
├── config.ts             Variables d'environnement validées (zod)
├── sources.ts            Flux suivis et liste des thèmes
├── db/                   SQLite : migrations versionnées, requêtes, FTS5
├── llm/                  Clients Mistral et compatible OpenAI : cadence, retry avec backoff
├── pipeline/             collect → enrich → run, planificateur
├── services/             ask (RAG), analyze, rapports, sources, coût, exports
└── interfaces/           telegram, http (API + tableau de bord), mcp
public/                   Tableau de bord (HTML, CSS, JavaScript sans dépendance)
tests/                    Tests d'intégration (base en mémoire, faux LLM)
```

---

## 7. Déploiement

Chaque push sur `main` déclenche la CI (lint, types, tests, build) puis `flyctl deploy` ([docs/ci-cd.md](docs/ci-cd.md), [docs/docker.md](docs/docker.md)).

```bash
flyctl secrets set MISTRAL_API_KEY=… TELEGRAM_BOT_TOKEN=… TELEGRAM_CHAT_ID=… \
  DASHBOARD_TOKEN=… MCP_TOKEN=… TAVILY_API_KEY=… --app veille-tech-dauvel
flyctl logs --app veille-tech-dauvel
```

La base vit sur le volume persistant `veille_data` monté sur `/data`. Les migrations s'appliquent seules au démarrage et conservent les données existantes.

---

## 8. Souveraineté numérique

| Composant | Solution | Origine | Alternative écartée |
|---|---|---|---|
| IA (résumés, analyse, RAG) | Mistral AI | 🇫🇷 France | GPT, Claude API (USA) |
| Hébergement | Fly.io, région Paris | Données en 🇫🇷 | AWS/GCP |
| Base de données | SQLite | Open source, embarquée | MongoDB Atlas (USA) |
| Sources francophones | Korben, Alsacréations, Human Coders | 🇫🇷 | — |
| Recherche web | Tavily (optionnelle) | 🇺🇸 USA | — |
| Versionnement | GitHub | 🇺🇸 USA | GitLab auto-hébergé possible |

Seuls des contenus publics (titres, extraits, URL) sont collectés : aucune donnée personnelle.

---

## 9. Compétences E1 couvertes

| Compétence | Éléments |
|---|---|
| **C1 — Organiser un système de veille** | Sources, pipeline automatisé, planification, notifications |
| **C2 — Analyser les informations** | Résumés, scores et thèmes, recherche plein texte, `/ask`, `/analyze`, digest hebdomadaire |
| **C3 — Expérimenter et mobiliser** | Déploiement continu, API, tableau de bord, serveur MCP pour Claude |

## 10. Pistes d'évolution

- Résumés à partir du texte complet des articles plutôt que de l'extrait du flux
- Recherche sémantique (embeddings `mistral-embed`) en complément de FTS5
- Sources YouTube (transcriptions)
- Sauvegarde automatique de la base hors du volume
