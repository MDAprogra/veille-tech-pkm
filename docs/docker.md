# Stratégie Docker — Multi-stage build

## Principe

```dockerfile
# Étape 1 : compilation
FROM node:22-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Étape 2 : exécution
FROM node:22-alpine AS production
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY public ./public
CMD ["node", "dist/index.js"]
```

## Justification

| Choix | Raison |
|---|---|
| Compilation dans une étape séparée | Le JavaScript est précompilé : pas de `tsx` ni de transpilation en mémoire au démarrage (cause du crash initial à 256 MB) |
| `npm prune --omit=dev` puis copie de `node_modules` | L'image finale ne contient ni `typescript`, ni Biome, ni compilateur C++ : `python3 make g++` ne servent qu'à l'étape de build (addon natif de `better-sqlite3`) |
| `node:22-alpine` | Image minimale, version LTS maintenue (Node 20 est en fin de vie depuis avril 2026) |
| `npm ci` | Installation reproductible à partir de `package-lock.json` |
| `public/` copié | Tableau de bord servi par Express |

## Évolution

| Version | Démarrage | Contenu de l'image |
|---|---|---|
| Initiale | `npx tsx src/index.ts` | Toutes les dépendances, transpilation à chaud |
| Multi-stage v1 | `node dist/index.js` | Dépendances de prod, mais chaîne de compilation C++ réinstallée dans l'image finale |
| Actuelle | `node dist/index.js` | Dépendances de prod uniquement, aucun outil de build |

## Santé

`fly.toml` déclare une sonde HTTP sur `GET /health` (toutes les 30 s), qui vérifie aussi l'accès à la base.
