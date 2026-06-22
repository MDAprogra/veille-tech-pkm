# Base de données — Modèle de données

## Choix technologique

**SQLite** via `better-sqlite3` (v12.10.1)

### Justification

| Critère | SQLite | PostgreSQL | MongoDB |
|---|---|---|---|
| Complexité opérationnelle | Nulle — fichier unique | Élevée — serveur dédié | Élevée — serveur dédié |
| Adapté au volume | ✅ < 100k articles | Surdimensionné | Surdimensionné |
| Données relationnelles | ✅ Oui | ✅ Oui | ❌ Non |
| Persistance Fly.io | ✅ Volume monté `/data` | Nécessite un add-on payant | Nécessite un add-on payant |
| Licence | Open source (domaine public) | Open source (PostgreSQL License) | Open source (SSPL) |
| Souveraineté numérique | ✅ Embarqué, aucune dépendance externe | ⚠️ Dépend de l'hébergeur | ⚠️ Dépend de l'hébergeur |

SQLite est le choix justifié pour ce projet : volume de données modéré (~quelques milliers d'articles), un seul processus écrivant en base, pas de requêtes concurrentes, déploiement simplifié sur Fly.io via volume persistant.

---

## Schéma de la base

### Table `articles`

Unique table de la base — contient l'intégralité des articles collectés, résumés et scorés.

```sql
CREATE TABLE IF NOT EXISTS articles (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT    NOT NULL,
    url          TEXT    UNIQUE NOT NULL,
    source       TEXT,
    summary      TEXT,
    content      TEXT,
    published_at TEXT,
    score        INTEGER DEFAULT 0,
    created_at   TEXT    DEFAULT (datetime('now'))
);
```

### Description des colonnes

| Colonne | Type | Contrainte | Description |
|---|---|---|---|
| `id` | INTEGER | PK, AUTOINCREMENT | Identifiant unique généré par SQLite |
| `title` | TEXT | NOT NULL | Titre de l'article tel que fourni par le flux RSS |
| `url` | TEXT | UNIQUE NOT NULL | URL canonique — clé de déduplication |
| `source` | TEXT | — | Nom de la source RSS (ex: "Dev.to", "Korben") |
| `summary` | TEXT | — | Résumé en 3-4 phrases généré par Mistral AI |
| `content` | TEXT | — | Extrait brut du flux RSS (limité à 2000 chars au traitement) |
| `published_at` | TEXT | — | Date de publication fournie par le flux RSS (ISO 8601) |
| `score` | INTEGER | DEFAULT 0 | Score de pertinence 1–5 attribué par Mistral AI |
| `created_at` | TEXT | DEFAULT datetime('now') | Date d'insertion en base (UTC) |

### Contraintes et index

- `UNIQUE` sur `url` — garantit l'absence de doublons, même si un article apparaît dans plusieurs collectes
- `INSERT OR IGNORE` — un article déjà présent est silencieusement ignoré sans erreur
- Pas d'index explicite — le volume actuel ne le justifie pas, SQLite utilise un B-tree sur la PK

---

## Migration

La base intègre un mécanisme de migration minimaliste pour la colonne `score`, ajoutée après la création initiale :

```typescript
try {
    db.exec(`ALTER TABLE articles ADD COLUMN score INTEGER DEFAULT 0`);
} catch {
    // Colonne déjà existante — on ignore
}
```

Ce pattern try/catch permet de déployer la migration de manière idempotente sans outil dédié.

---

## Requêtes principales

### Insertion d'un article

```sql
INSERT OR IGNORE INTO articles 
    (title, url, source, summary, content, published_at, score)
VALUES 
    (@title, @url, @source, @summary, @content, @published_at, @score)
```

### Articles récents

```sql
SELECT * FROM articles 
ORDER BY created_at DESC 
LIMIT ?
```

### Recherche full-text (simplifiée)

```sql
SELECT * FROM articles 
WHERE title LIKE ? OR summary LIKE ? OR content LIKE ?
ORDER BY created_at DESC 
LIMIT ?
```

### Export pour analyse

```sql
SELECT * FROM articles 
WHERE summary != 'Résumé indisponible.'
ORDER BY created_at DESC
```

---

## Infrastructure de stockage

- **Fichier** : `/data/veille.db`
- **Volume Fly.io** : `vol_r68njqo9plgmemj4` — persistant entre les déploiements
- **Taille actuelle** : ~2.2MB
- **Capacité estimée** : SQLite supporte jusqu'à 281TB — largement suffisant pour ce cas d'usage
- **Sauvegarde** : non automatisée à ce stade — à prévoir (Fly.io snapshots ou export CSV périodique)

---

## Évolutions prévues

| Évolution | Justification | Priorité |
|---|---|---|
| Index sur `score` et `created_at` | Optimiser les requêtes de filtrage quand le volume dépasse 10k articles | Basse |
| Export CSV automatique | Alimenter le dataset d'entraînement du modèle scikit-learn (C.27-I) | Haute |
| Sauvegarde automatique | PRA — éviter la perte de données en cas de corruption du volume | Moyenne |
| Full-text search SQLite (FTS5) | Remplacer les `LIKE` par un index FTS pour de meilleures performances de recherche | Basse |