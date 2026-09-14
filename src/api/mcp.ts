import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { type Express } from 'express';
import { z } from 'zod';
import { exportAllArticles, getRecentArticles, searchArticles } from '../storage/database.js';

export function setupMCP(app: Express) {
    const server = new McpServer({
        name: 'veille-tech-pkm',
        version: '1.0.0',
    });

    // Outil 1 — Recherche dans la veille
    server.tool(
        'search_articles',
        'Recherche des articles dans la base de veille technologique',
        {
            query: z.string().describe('Terme de recherche'),
            limit: z.number().optional().default(5).describe('Nombre de résultats'),
        },
        async ({ query, limit }) => {
            const articles = searchArticles(query, limit) as any[];
            if (articles.length === 0) {
                return {
                    content: [{
                        type: 'text',
                        text: `Aucun article trouvé pour "${query}"`,
                    }],
                };
            }
            const text = articles.map(a =>
                `## ${a.title}\n- **Source** : ${a.source}\n- **Score** : ${a.score}/5\n- **Résumé** : ${a.summary}\n- **Lien** : ${a.url}\n- **Date** : ${a.published_at}`
            ).join('\n\n---\n\n');
            return { content: [{ type: 'text', text }] };
        }
    );

    // Outil 2 — Derniers articles
    server.tool(
        'get_recent_articles',
        'Récupère les derniers articles collectés',
        {
            limit: z.number().optional().default(10).describe('Nombre d\'articles'),
        },
        async ({ limit }) => {
            const articles = getRecentArticles(limit) as any[];
            const text = articles.map(a =>
                `## ${a.title}\n- **Source** : ${a.source}\n- **Score** : ${a.score}/5\n- **Résumé** : ${a.summary}\n- **Lien** : ${a.url}`
            ).join('\n\n---\n\n');
            return { content: [{ type: 'text', text }] };
        }
    );

    // Outil 3 — Statistiques
    server.tool(
        'get_stats',
        'Retourne les statistiques de la base de veille',
        {},
        async () => {
            const all = exportAllArticles() as any[];
            const bySource = all.reduce<Record<string, number>>((acc, a) => {
                acc[a.source] = (acc[a.source] ?? 0) + 1;
                return acc;
            }, {});
            const avgScore = all.reduce((sum, a) => sum + (a.score ?? 0), 0) / all.length;

            const text = `# Statistiques de la veille\n\n` +
                `- **Total articles** : ${all.length}\n` +
                `- **Score moyen** : ${avgScore.toFixed(2)}/5\n\n` +
                `## Par source\n` +
                Object.entries(bySource)
                    .sort(([, a], [, b]) => b - a)
                    .map(([source, count]) => `- ${source} : ${count} articles`)
                    .join('\n');

            return { content: [{ type: 'text', text }] };
        }
    );

    // Outil 4 — Export complet
    server.tool(
        'export_all',
        'Exporte tous les articles de la veille (pour analyse globale)',
        {
            min_score: z.number().optional().default(0).describe('Score minimum'),
        },
        async ({ min_score }) => {
            const all = exportAllArticles() as any[];
            const filtered = all.filter(a => (a.score ?? 0) >= min_score);
            const text = filtered.map(a =>
                `## ${a.title}\n- **Source** : ${a.source}\n- **Score** : ${a.score}/5\n- **Résumé** : ${a.summary}`
            ).join('\n\n---\n\n');
            return { content: [{ type: 'text', text }] };
        }
    );

    // Outil 5 — Chronologie des sujets
server.tool(
    'get_timeline',
    'Génère une chronologie des sujets et tendances semaine par semaine',
    {
        weeks: z.number().optional().default(12).describe('Nombre de semaines à analyser'),
        min_score: z.number().optional().default(3).describe('Score minimum des articles'),
    },
    async ({ weeks, min_score }) => {
        const all = exportAllArticles() as any[];
        const filtered = all.filter(a => (a.score ?? 0) >= min_score);

        // Grouper par semaine
        const byWeek = filtered.reduce<Record<string, any[]>>((acc, a) => {
            const date = new Date(a.created_at);
            // Calcul du lundi de la semaine
            const day = date.getDay();
            const diff = date.getDate() - day + (day === 0 ? -6 : 1);
            const monday = new Date(date.setDate(diff));
            const key = monday.toISOString().split('T')[0];
            if (!acc[key]) acc[key] = [];
            acc[key].push(a);
            return acc;
        }, {});

        // Limiter au nombre de semaines demandé
        const sortedWeeks = Object.keys(byWeek)
            .sort((a, b) => b.localeCompare(a))
            .slice(0, weeks);

        let text = `# Chronologie de la veille technologique\n\n`;
        text += `*${filtered.length} articles analysés sur ${sortedWeeks.length} semaines*\n\n`;

        for (const week of sortedWeeks) {
            const articles = byWeek[week];
            const weekDate = new Date(week).toLocaleDateString('fr-FR', {
                day: 'numeric',
                month: 'long',
                year: 'numeric'
            });

            // Extraire les mots-clés fréquents des titres
            const keywords = articles
                .flatMap(a => a.title.split(/\s+/))
                .filter(w => w.length > 4)
                .reduce<Record<string, number>>((acc, w) => {
                    const key = w.toLowerCase().replace(/[^a-z0-9]/g, '');
                    if (key) acc[key] = (acc[key] ?? 0) + 1;
                    return acc;
                }, {});

            const topKeywords = Object.entries(keywords)
                .sort(([, a], [, b]) => b - a)
                .slice(0, 5)
                .map(([word]) => word);

            // Grouper par source
            const sources = articles.reduce<Record<string, number>>((acc, a) => {
                acc[a.source] = (acc[a.source] ?? 0) + 1;
                return acc;
            }, {});
            const topSource = Object.entries(sources)
                .sort(([, a], [, b]) => b - a)[0];

            text += `## 📅 Semaine du ${weekDate}\n`;
            text += `*${articles.length} articles collectés*\n\n`;
            text += `**🔑 Mots-clés dominants** : ${topKeywords.join(', ')}\n`;
            text += `**📰 Source principale** : ${topSource?.[0]} (${topSource?.[1]} articles)\n\n`;

            // Top 3 articles de la semaine
            const top3 = articles
                .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
                .slice(0, 3);

            text += `**⭐ Top articles**\n`;
            for (const a of top3) {
                text += `- ${'⭐'.repeat(a.score ?? 0)} ${a.title} *(${a.source})*\n`;
                text += `  > ${a.summary?.slice(0, 150)}...\n`;
            }
            text += '\n---\n\n';
        }

        return { content: [{ type: 'text', text }] };
    }
);

    // Endpoint SSE pour MCP
    const transports: Record<string, SSEServerTransport> = {};

    app.get('/mcp', async (req, res) => {
        const transport = new SSEServerTransport('/mcp/message', res);
        transports[transport.sessionId] = transport;
        await server.connect(transport);
        res.on('close', () => {
            delete transports[transport.sessionId];
        });
    });

    app.post('/mcp/message', async (req, res) => {
        const sessionId = req.query.sessionId as string;
        const transport = transports[sessionId];
        if (!transport) {
            res.status(404).json({ error: 'Session non trouvée' });
            return;
        }
        await transport.handlePostMessage(req, res);
    });

    console.log('🔌 Serveur MCP configuré sur /mcp');
}