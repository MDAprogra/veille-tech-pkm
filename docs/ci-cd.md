# CI/CD — GitHub Actions

Fichier : `.github/workflows/ci.yml`

## Job 1 — quality

Déclenché sur `push` et `pull_request` vers `main`.

| Étape | Commande | Rôle |
|---|---|---|
| Checkout | actions/checkout@v4 | Récupère le code |
| Setup Node.js | actions/setup-node@v4 | Node 22, cache npm |
| Install | `npm ci` | Installation reproductible |
| Lint | `npm run lint` | Biome : lint, format, imports (src, tests, scripts) |
| Types | `npm run typecheck` | `tsc --noEmit` en mode strict |
| Tests | `npm test` | `node:test` : base SQLite en mémoire, faux LLM, serveur HTTP et MCP réels |
| Build | `npm run build` | Vérifie que la compilation de production passe |

En local, `npm run check` enchaîne lint, types et tests ; `npm run format` corrige le formatage.

## Job 2 — deploy

Déclenché sur `push` vers `main` uniquement, et seulement si `quality` réussit : `flyctl deploy --remote-only`.

| Secret | Usage |
|---|---|
| `FLY_API_TOKEN` | Jeton de déploiement Fly.io (app `veille-tech-dauvel`) |

## Ce que couvrent les tests

| Fichier | Vérifie |
|---|---|
| `tests/store.test.ts` | Reprise d'une base v1, recherche FTS5 (accents, préfixes, saisie hostile), filtres, statistiques |
| `tests/pipeline.test.ts` | Collecte, déduplication, aucun appel IA pour un article connu, reprise sur erreur, panne du fournisseur, retry, plage horaire |
| `tests/features.test.ts` | Sources (ajout vérifié, adresses internes refusées, propositions de l'IA), groupes de doublons, actions de lecture, pagination, tendances, rapports, coût |
| `tests/interfaces.test.ts` | Authentification de l'API, filtres, exports, outils MCP et jeton MCP, RAG `/ask`, mise en forme Telegram, configuration |

## Historique

| Run | Résultat | Enseignement |
|---|---|---|
| CI #1 | ❌ | Newline manquante détectée par Biome — le garde-fou fonctionne |
| CI #2, #3 | ✅ | Correctif, puis déploiement automatique opérationnel |
| Avant la v2 | ❌ | `src/api/mcp.ts` et `summarizer.ts` non formatés : `biome check` échoue sur ce commit, ce qui bloque le job `quality` et donc le déploiement |
| v2 | ✅ | Lint, types, tests et build verts |
