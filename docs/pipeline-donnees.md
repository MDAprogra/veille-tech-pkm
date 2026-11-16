# Pipeline de données — Veille technologique

```
16 flux RSS → Collecte → Déduplication → Enrichissement Mistral → SQLite/FTS5 → Notification
```

## Sources

Définies dans `src/sources.ts` (nom, URL, catégorie, langue).

| Catégorie | Sources |
|---|---|
| Front / Web | Dev.to, Smashing Magazine, web.dev, JavaScript Weekly, Frontend Focus, This Week in React, Node Weekly, Deno Blog |
| IA / LLM | arXiv cs.AI + cs.LG, arXiv cs.CL |
| Francophone / communauté | Korben 🇫🇷, Alsacréations 🇫🇷, Human Coders 🇫🇷, Reddit r/webdev |
| Infra / sécurité | Krebs on Security, The New Stack |

**Fréquence** : toutes les 2 h, de 9 h à 19 h (Europe/Paris) — `COLLECT_INTERVAL_MINUTES`, `ACTIVE_HOURS`.
**Volume** : 5 articles max par source et par collecte (`ITEMS_PER_SOURCE`).

## Étapes

### 1. Collecte (`src/pipeline/collect.ts`)

- 4 flux lus en parallèle, délai maximal de 20 s par flux, `User-Agent` explicite (exigé par Reddit).
- Nettoyage : HTML retiré, contenu limité à 6 000 caractères, dates converties en ISO 8601.
- URL canonique : suppression de `utm_*`, `fbclid`, `gclid` et de l'ancre.
- Une source en échec est journalisée et listée dans le bilan de la collecte ; les autres continuent.

### 2. Déduplication (`src/pipeline/run.ts`)

Les URL déjà en base sont écartées **avant** tout appel à l'IA. Les nouveaux articles sont insérés avec le statut `pending`. Un arrêt du processus en cours de collecte ne perd donc rien : la file est reprise à la collecte suivante.

### 3. Enrichissement (`src/pipeline/enrich.ts`, `src/llm/mistral.ts`)

- Modèle `mistral-small-latest`, mode JSON, température 0,2.
- Sortie validée par schéma : résumé (3-4 phrases, en français), score borné à 1–5, thèmes filtrés sur la liste autorisée.
- Le contenu de l'article est délimité dans le prompt et présenté comme une donnée, pour limiter l'injection d'instructions.
- Cadence : 1,5 s minimum entre deux appels. Erreurs 429, 5xx et réseau : 3 nouveaux essais avec attente croissante (15 s, 30 s, 60 s).
- Plafond de 60 enrichissements par collecte (`MAX_ENRICH_PER_RUN`).

| Situation | Traitement |
|---|---|
| Réponse inexploitable (JSON invalide, résumé vide) | Article `failed`, retenté aux collectes suivantes, abandon après 3 essais |
| Mistral indisponible, quota épuisé, clé invalide | Enrichissement interrompu, articles laissés en file sans compter d'essai |
| `MISTRAL_API_KEY` absente | Collecte seule, articles en attente |

### 4. Notification (`src/interfaces/telegram.ts`)

Articles `done`, de score ≥ 4 (`NOTIFY_MIN_SCORE`), jamais notifiés et collectés depuis moins de 2 jours. Messages regroupés par source, en HTML échappé, découpés sans couper un article. `notified_at` garantit qu'un article n'est notifié qu'une fois.

### 5. Digest hebdomadaire

Le lundi, après la première collecte : analyse Mistral des 7 derniers jours (tendances, lacunes, recommandations) envoyée sur Telegram.

## Contrôles qualité

| Contrôle | Mécanisme |
|---|---|
| Doublons | URL canonique + contrainte `UNIQUE` |
| Coût IA | Aucun appel pour un article déjà traité ; plafond par collecte |
| Sources en échec | Isolées, listées dans `runs.sources_failed` |
| Rate limit Mistral | Cadence minimale + retry avec backoff |
| Collectes concurrentes | Verrou du planificateur (`/collect` pendant une collecte : refusé) |
| Redéploiement | Prochaine collecte calculée depuis la dernière enregistrée |
| Traçabilité | Table `runs`, commandes `/infos` et `/logs`, `GET /api/runs` |

## Types métier

```typescript
interface Article {
	id: number;
	title: string;
	url: string;
	source: string;
	summary: string | null;
	content: string;
	published_at: string | null;
	score: number;                       // 1-5, 0 = non noté
	tags: string[];                      // thèmes de la liste fermée
	status: "pending" | "done" | "failed";
	attempts: number;
	created_at: string;
	notified_at: string | null;
}
```

## Conformité RGPD

Seuls des **contenus publics** sont collectés (titres, URL, extraits). Aucune donnée personnelle n'est collectée, stockée ou traitée.
