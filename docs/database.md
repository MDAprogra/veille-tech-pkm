# Base de données — Modèle de données

## Choix technologique

**SQLite** via `better-sqlite3`, en mode WAL, avec l'extension **FTS5** pour la recherche plein texte.

| Critère | SQLite | PostgreSQL | MongoDB |
|---|---|---|---|
| Complexité opérationnelle | Nulle — fichier unique | Serveur dédié | Serveur dédié |
| Adapté au volume | ✅ < 100k articles | Surdimensionné | Surdimensionné |
| Recherche plein texte | ✅ FTS5 intégré | ✅ | ✅ |
| Persistance Fly.io | ✅ Volume monté `/data` | Add-on payant | Add-on payant |
| Souveraineté | ✅ Embarqué, aucune dépendance externe | ⚠️ Dépend de l'hébergeur | ⚠️ Dépend de l'hébergeur |

Un seul processus écrit en base, le volume est modéré : SQLite suffit largement.

## Schéma

### Table `articles`

| Colonne | Type | Description |
|---|---|---|
| `id` | INTEGER PK | Identifiant |
| `title` | TEXT NOT NULL | Titre (HTML retiré) |
| `url` | TEXT UNIQUE NOT NULL | URL sans paramètres de tracking — clé de déduplication |
| `source` | TEXT | Nom de la source |
| `summary` | TEXT | Résumé Mistral (NULL tant que l'article n'est pas enrichi) |
| `content` | TEXT | Extrait du flux, texte brut, 6 000 caractères max |
| `published_at` | TEXT | Date de publication, ISO 8601 |
| `score` | INTEGER | Pertinence 1–5 (0 = non noté) |
| `tags` | TEXT (JSON) | Tableau de 0 à 3 thèmes d'une liste fermée |
| `status` | TEXT | `pending` (à enrichir), `done`, `failed` |
| `attempts` | INTEGER | Tentatives d'enrichissement (abandon à 3) |
| `notified_at` | TEXT | Date de notification Telegram (NULL = jamais notifié) |
| `created_at` | TEXT | Date d'insertion (UTC) |

Index : `created_at`, `status`, `score`.

### Table virtuelle `articles_fts` (FTS5)

Indexe `title`, `summary`, `content` (table à contenu externe, synchronisée par trois triggers). Tokenizer `unicode61 remove_diacritics 2` : « securite » trouve « Sécurité ». Classement **BM25** pondéré : titre ×8, résumé ×4, contenu ×1.

Une question libre est convertie en requête : mots vides retirés, mots-clés combinés en `OR` avec préfixe (`"react"* OR "compil"*`). Les mots sont mis entre guillemets, ce qui neutralise la syntaxe FTS dans la saisie de l'utilisateur.

### Table `runs`

Une ligne par collecte : `started_at`, `finished_at`, `fetched`, `inserted`, `enriched`, `failed`, `notified`, `sources_failed` (JSON), `error`. Elle remplace les compteurs en mémoire, perdus à chaque redémarrage, et sert à ne pas recollecter après un redéploiement.

### Table `meta`

Clé/valeur (ex. `last_digest` : date du dernier digest hebdomadaire).

## Migrations

`src/db/migrations.ts` — liste ordonnée de fonctions, version courante stockée dans `PRAGMA user_version`, chaque migration dans une transaction.

- **v1** : schéma historique (`CREATE TABLE IF NOT EXISTS`).
- **v2** : colonnes `tags`, `status`, `attempts`, `notified_at` ; index ; FTS5 et triggers, reconstruits sur l'existant ; tables `runs` et `meta`. Les données en place sont reprises : articles existants marqués comme déjà notifiés, anciens « Résumé indisponible. » remis en file (`failed`), dates RFC 822 converties en ISO 8601.

Un test (`tests/store.test.ts`) crée une base au format v1 et vérifie la reprise.

## Requêtes principales

```sql
-- File d'enrichissement : nouveaux d'abord, puis échecs à retenter
SELECT * FROM articles
WHERE status = 'pending' OR (status = 'failed' AND attempts < 3)
ORDER BY status = 'pending' DESC, created_at DESC LIMIT ?;

-- Recherche plein texte
SELECT a.* FROM articles_fts f JOIN articles a ON a.id = f.rowid
WHERE articles_fts MATCH ? AND a.status = 'done'
ORDER BY bm25(articles_fts, 8.0, 4.0, 1.0) LIMIT ?;

-- Filtre par thème
SELECT * FROM articles a
WHERE EXISTS (SELECT 1 FROM json_each(a.tags) WHERE value = ?);
```

## Stockage et exports

- Fichier `/data/veille.db` sur le volume Fly.io `veille_data`, persistant entre les déploiements.
- Export Markdown et **CSV** (`/export csv`, `GET /api/export.csv`) — le CSV sert de jeu de données pour une analyse ou un modèle.
- Sauvegarde : non automatisée (snapshots Fly.io du volume) — à prévoir.
