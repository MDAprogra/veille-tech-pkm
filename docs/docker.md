# Stratégie Docker — Multi-stage build

## Problème initial

Le Dockerfile original utilisait `npx tsx src/index.ts` comme commande de démarrage :

```dockerfile
FROM node:20-alpine
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
CMD ["npx", "tsx", "src/index.ts"]
```

### Conséquences

- `npm install` installe **toutes** les dépendances y compris les `devDependencies` (`typescript`, `tsx`, `@types/*`)
- `tsx` transpile TypeScript en mémoire à chaque démarrage — coûteux en RAM
- Résultat : la machine crashait au démarrage avec 256MB de RAM allouée

## Solution — Multi-stage build

```dockerfile
# Stage 1 : compilation
FROM node:20-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# Stage 2 : production
FROM node:20-alpine AS production
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
CMD ["node", "dist/index.js"]
```

## Résultats

| Métrique | Avant | Après |
|---|---|---|
| RAM requise au démarrage | > 512MB | ≤ 256MB |
| Dépendances en prod | toutes (dev + prod) | prod uniquement |
| Commande de démarrage | `npx tsx src/index.ts` | `node dist/index.js` |
| Transpilation au runtime | oui (tsx à chaud) | non (JS précompilé) |

## Justification des choix

**`node:20-alpine`** — image minimale (~50MB), LTS, open source.

**`python3 make g++`** — requis pour la compilation native de `better-sqlite3` qui inclut un addon C++ (`better_sqlite3.node`).

**`npm ci` vs `npm install`** — `npm ci` est reproductible et plus rapide en CI : il installe exactement ce que `package-lock.json` décrit sans résolution de conflits.

**`--omit=dev`** — exclut `typescript`, `tsx`, `@types/*` du container de production. Ces outils ne sont utiles qu'au build.

## Souveraineté numérique

- Image de base open source (Node.js Foundation / OpenJS)
- Aucune dépendance à un registre d'images privé
- Build reproductible via `package-lock.json` versionné