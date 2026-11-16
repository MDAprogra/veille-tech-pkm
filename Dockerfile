# ── Étape 1 : compilation TypeScript ─────────────────────────────────────
FROM node:22-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ── Étape 2 : image d'exécution (sans compilateur ni devDependencies) ────
FROM node:22-alpine AS production
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY public ./public
EXPOSE 3000
CMD ["node", "dist/index.js"]
