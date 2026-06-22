## Jobs

### Job 1 — quality

Déclenché sur : `push` et `pull_request` sur `main`

| Étape | Outil | Rôle |
|---|---|---|
| Checkout | actions/checkout@v4 | Récupère le code source |
| Setup Node.js | actions/setup-node@v4 | Node 20 avec cache npm |
| Install dependencies | npm ci | Installation reproductible |
| Biome check | @biomejs/biome 2.5.0 | Lint + format + imports |
| TypeScript type check | tsc --noEmit | Vérification des types sans compilation |

### Job 2 — deploy

Déclenché sur : `push` sur `main` uniquement (pas les PRs)  
Condition : `needs: quality` — ne s'exécute que si `quality` passe

| Étape | Outil | Rôle |
|---|---|---|
| Checkout | actions/checkout@v4 | Récupère le code source |
| Install Fly CLI | superfly/flyctl-actions | Installation de flyctl |
| Deploy | flyctl deploy --remote-only | Build et déploiement sur Fly.io |

## Secrets GitHub Actions

| Secret | Usage |
|---|---|
| `FLY_API_TOKEN` | Token de déploiement Fly.io (scope : app `veille-tech-dauvel`) |

## Historique des runs

| Run | Commit | Résultat | Enseignement |
|---|---|---|---|
| CI #1 | 23b4e7b | ❌ | Newline manquante détectée par Biome — preuve que le gate fonctionne |
| CI #2 | df54d62 | ✅ | Fix appliqué, qualité validée |
| CI #3 | e30d5ab | ✅ | Déploiement automatique opérationnel |

## Souveraineté numérique

- Hébergement : Fly.io, datacenter Paris (cdg) 🇫🇷
- Aucune dépendance à un registre privé
- Image de base : `node:20-alpine` (open source)