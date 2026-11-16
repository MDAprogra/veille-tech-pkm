// Tableau de bord de la veille — JavaScript sans dépendance.
// Tout contenu venant de l'API est inséré avec textContent : jamais de HTML interprété.

const PAGE_SIZE = 25;
const $ = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";

function el(tag, props = {}, ...children) {
	const node = Object.assign(document.createElement(tag), props);
	node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
	return node;
}

/** Remplace le contenu d'un nœud en ignorant les valeurs vides (null, false) des rendus conditionnels. */
function fill(node, ...children) {
	node.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
}

function svg(tag, attrs = {}, ...children) {
	const node = document.createElementNS(SVG, tag);
	for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
	node.append(...children);
	return node;
}

// sessionStorage peut être indisponible (navigation privée stricte) : repli en mémoire.
const session = {
	value: null,
	get() {
		try {
			return sessionStorage.getItem("veille_token") ?? this.value;
		} catch {
			return this.value;
		}
	},
	set(v) {
		this.value = v;
		try {
			if (v) sessionStorage.setItem("veille_token", v);
			else sessionStorage.removeItem("veille_token");
		} catch {}
	},
};

// ── Accès à l'API ─────────────────────────────────────────────────────────

async function api(path, { method = "GET", body } = {}) {
	const res = await fetch(`/api${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${session.get()}`,
			...(body !== undefined ? { "Content-Type": "application/json" } : {}),
		},
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	if (res.status === 401) {
		session.set(null);
		showLogin("Jeton refusé.");
		throw new Error("401");
	}
	return res;
}

/** Appel JSON : lève une erreur portant le message du serveur si la réponse n'est pas un succès. */
async function json(path, options) {
	const res = await api(path, options);
	const data = res.status === 204 ? null : await res.json().catch(() => null);
	if (!res.ok) throw new Error(data?.error ?? `Erreur ${res.status}`);
	return data;
}

function notify(message) {
	$("notice").textContent = message;
	$("notice").hidden = !message;
	if (message) $("notice").scrollIntoView({ block: "nearest" });
}

/** Exécute une action en signalant toute erreur dans le bandeau plutôt que de l'avaler. */
async function attempt(action) {
	try {
		notify("");
		return await action();
	} catch (err) {
		if (err.message !== "401") notify(err.message || "Une erreur est survenue.");
		return undefined;
	}
}

// ── Mise en forme ─────────────────────────────────────────────────────────

/** Les dates SQLite sont en UTC sans suffixe (« 2026-06-15 08:00:00 »). */
const toDate = (value) => new Date(/^\d{4}-\d{2}-\d{2} /.test(value) ? `${value.replace(" ", "T")}Z` : value);
const day = (value) => (value ? toDate(value).toLocaleDateString("fr-FR") : "—");
const dayTime = (value) =>
	value ? toDate(value).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "—";
const shortDay = (value) => toDate(value).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
const stars = (score) => `${"★".repeat(score)}${"☆".repeat(Math.max(0, 5 - score))}`;
const money = (value) =>
	value > 0 && value < 0.01
		? "< 0,01 $"
		: `${value.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
const count = (n) => n.toLocaleString("fr-FR");
const safeUrl = (url) => (/^https?:\/\//i.test(url) ? url : "#");

function table(headers, rows, emptyMessage = "Aucune donnée.") {
	if (rows.length === 0) return el("p", { className: "muted", textContent: emptyMessage });
	return el(
		"table",
		{},
		el("thead", {}, el("tr", {}, headers.map((h) => el("th", { textContent: h.label, className: h.num ? "num" : "" })))),
		el(
			"tbody",
			{},
			rows.map((cells) =>
				el("tr", {}, cells.map((cell, i) => el("td", { className: headers[i].num ? "num" : "" }, cell ?? "—"))),
			),
		),
	);
}

function bars(target, record, { limit = 14, label = (k) => k, value = (n) => String(n), unit = "article(s)" } = {}) {
	const entries = Object.entries(record).slice(0, limit);
	const max = Math.max(...entries.map(([, n]) => n), 0) || 1;
	$(target).replaceChildren(
		...(entries.length ? entries : [["—", 0]]).map(([key, n]) =>
			el(
				"div",
				{ className: "bar-row", title: `${label(key)} : ${value(n)} ${unit}` },
				el("span", { textContent: label(key) }),
				el(
					"div",
					{ className: "track" },
					el("div", { className: "bar", style: `width:${(n / max) * 85}%` }),
					el("span", { textContent: value(n) }),
				),
			),
		),
	);
}

/** Rendu minimal de Markdown (titres, listes, citations, gras, italique, code) en nœuds DOM. */
function markdown(text) {
	const root = el("div", { className: "markdown" });
	const inline = (line) =>
		line.split(/(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`)/).map((part) => {
			if (/^\*\*.+\*\*$/.test(part)) return el("strong", { textContent: part.slice(2, -2) });
			if (/^\*.+\*$/.test(part)) return el("em", { textContent: part.slice(1, -1) });
			if (/^`.+`$/.test(part)) return el("code", { textContent: part.slice(1, -1) });
			return part;
		});
	let list = null;
	let paragraph = null;
	for (const raw of text.split("\n")) {
		const line = raw.trimEnd();
		const heading = line.match(/^(#{1,4})\s+(.*)$/);
		const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
		const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
		if (!bullet && !numbered) list = null;
		if (!line.trim()) {
			paragraph = null;
		} else if (heading) {
			paragraph = null;
			root.append(el(`h${Math.min(4, heading[1].length + 1)}`, {}, inline(heading[2])));
		} else if (/^-{3,}$/.test(line.trim())) {
			paragraph = null;
			root.append(el("hr"));
		} else if (line.startsWith(">")) {
			paragraph = null;
			root.append(el("blockquote", {}, inline(line.replace(/^>\s?/, ""))));
		} else if (bullet || numbered) {
			paragraph = null;
			const tag = bullet ? "ul" : "ol";
			if (!list || list.tagName.toLowerCase() !== tag) {
				list = el(tag);
				root.append(list);
			}
			list.append(el("li", {}, inline((bullet ?? numbered)[1])));
		} else if (paragraph) {
			paragraph.append(" ", ...inline(line.trim()));
		} else {
			paragraph = el("p", {}, inline(line.trim()));
			root.append(paragraph);
		}
	}
	return root;
}

// ── Navigation ────────────────────────────────────────────────────────────

const VIEWS = {
	articles: loadArticlesView,
	tendances: loadTrends,
	rapport: loadReports,
	sources: loadSources,
	systeme: loadSystem,
};
let suggestTimer = null;

function showLogin(message = "") {
	$("app").hidden = true;
	$("login").hidden = false;
	$("login-error").textContent = message;
}

function currentView() {
	const name = location.hash.slice(1);
	return name in VIEWS ? name : "articles";
}

async function route() {
	const name = currentView();
	clearTimeout(suggestTimer);
	notify("");
	for (const view of document.querySelectorAll(".view")) view.hidden = view.id !== `view-${name}`;
	for (const link of document.querySelectorAll("#tabs a")) {
		if (link.getAttribute("href") === `#${name}`) link.setAttribute("aria-current", "page");
		else link.removeAttribute("aria-current");
	}
	await attempt(VIEWS[name]);
}

// ── Articles ──────────────────────────────────────────────────────────────

let page = 1;
let stats = null;

async function loadStats() {
	stats = await json("/stats");
	const tile = (value, label) =>
		el("div", { className: "panel tile" }, el("b", { textContent: String(value) }), el("span", { className: "muted", textContent: label }));
	$("tiles").replaceChildren(
		tile(count(stats.total), "articles résumés"),
		tile(stats.averageScore ?? "—", "score moyen / 5"),
		tile(count(stats.unread), "non lus"),
		tile(count(stats.favorites), "favoris"),
		tile(stats.sources, "sources suivies"),
		tile(money(stats.usage.month.cost), "coût de l'IA ce mois-ci"),
	);
	const pending = stats.pending ? `${stats.pending} article(s) en attente de résumé · ` : "";
	$("status").textContent = stats.collecting
		? "Collecte en cours…"
		: `${pending}${stats.nextRunAt ? `prochaine collecte : ${dayTime(stats.nextRunAt)}` : ""}`;
	$("sources-badge").textContent = stats.suggestedSources;
	$("sources-badge").hidden = !stats.suggestedSources;
	const fill = (id, values) => {
		if ($(id).options.length === 1) $(id).append(...values.map((v) => el("option", { value: v, textContent: v })));
	};
	fill("tag", stats.tags);
	fill("source", Object.keys(stats.bySource));
}

function filterParams() {
	const params = new URLSearchParams();
	for (const id of ["tag", "source", "min_score"]) if ($(id).value) params.set(id, $(id).value);
	for (const id of ["favorite", "unread", "dismissed"]) if ($(id).checked) params.set(id, "1");
	return params;
}

function articleRow(a) {
	const favorite = el("button", {
		className: "small",
		textContent: a.favorite ? "★ Favori" : "☆ Favori",
		ariaPressed: String(a.favorite),
		title: a.favorite ? "Retirer des favoris" : "Ajouter aux favoris",
		onclick: () => attempt(async () => {
			await json(`/articles/${a.id}`, { method: "PATCH", body: { favorite: !a.favorite } });
			await refreshArticles();
		}),
	});
	return el(
		"div",
		{ className: `article${a.read_at ? " read" : ""}${a.dismissed ? " dismissed" : ""}` },
		el(
			"div",
			{},
			el("button", { className: "link", textContent: a.title, onclick: () => openFiche(a.id) }),
			el(
				"div",
				{ className: "muted" },
				`${stars(a.score)} · ${a.source} · ${day(a.published_at ?? a.created_at)}`,
				a.coverage > 1 && el("span", { className: "tag strong", textContent: `couvert par ${a.coverage} sources`, title: `Aussi : ${a.also_in.join(", ")}` }),
				a.read_at && el("span", { className: "tag", textContent: "lu" }),
				a.dismissed && el("span", { className: "tag", textContent: "pas pertinent" }),
				a.tags.map((t) => el("span", { className: "tag", textContent: t })),
			),
		),
		favorite,
		el("p", { textContent: a.summary ?? "" }),
	);
}

async function loadArticles() {
	const params = filterParams();
	const q = $("q").value.trim();
	if (q) params.set("q", q);
	params.set("limit", String(q ? 50 : PAGE_SIZE));
	if (!q && page > 1) params.set("offset", String((page - 1) * PAGE_SIZE));

	const res = await api(`/articles?${params}`);
	if (!res.ok) throw new Error("Impossible de charger les articles.");
	const articles = await res.json();
	const total = Number(res.headers.get("X-Total-Count") ?? articles.length);
	const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

	$("count").textContent = q
		? `${articles.length} résultat(s), triés par pertinence`
		: `${count(total)} article(s) — du plus récent au plus ancien`;
	$("articles").replaceChildren(
		...(articles.length ? articles.map(articleRow) : [el("p", { className: "muted", textContent: "Aucun article ne correspond à ces filtres." })]),
	);
	const go = (target) => () => {
		page = target;
		attempt(loadArticles).then(() => $("filters").scrollIntoView({ block: "start" }));
	};
	$("pager").replaceChildren(
		...(q || pages <= 1
			? []
			: [
					el("button", { textContent: "← Précédent", disabled: page <= 1, onclick: go(page - 1) }),
					el("span", { className: "muted", textContent: `Page ${page} sur ${pages}` }),
					el("button", { textContent: "Suivant →", disabled: page >= pages, onclick: go(page + 1) }),
				]),
	);
}

const refreshArticles = () => Promise.all([loadStats(), loadArticles()]);

async function loadArticlesView() {
	await refreshArticles();
}

async function download(ext) {
	const res = await api(`/export.${ext}?${filterParams()}`);
	if (!res.ok) throw new Error("Export impossible.");
	saveBlob(await res.blob(), `veille_export_${new Date().toISOString().slice(0, 10)}.${ext}`);
}

function saveBlob(blob, filename) {
	const link = el("a", { href: URL.createObjectURL(blob), download: filename });
	link.click();
	URL.revokeObjectURL(link.href);
}

// ── Fiche d'un article ────────────────────────────────────────────────────

async function openFiche(id) {
	const data = await attempt(() => json(`/articles/${id}`));
	if (!data) return;
	const { article: a, primary, coveredBy, related } = data;
	const update = (changes) => () =>
		attempt(async () => {
			await json(`/articles/${a.id}`, { method: "PATCH", body: changes });
			await openFiche(a.id);
			if (currentView() === "articles") await refreshArticles();
		});
	const linkTo = (other) =>
		el(
			"li",
			{},
			el("button", { className: "link", style: "font-size:14px", textContent: other.title, onclick: () => openFiche(other.id) }),
			el("span", { className: "muted", textContent: ` — ${other.source}, ${day(other.published_at ?? other.created_at)}` }),
		);

	fill(
		$("fiche-body"),
		el("button", { className: "close small", textContent: "Fermer", onclick: () => $("fiche").close() }),
		el("h2", { id: "fiche-title", textContent: a.title }),
		el(
			"div",
			{ className: "muted" },
			`${stars(a.score)} · ${a.source} · publié le ${day(a.published_at ?? a.created_at)} · collecté le ${day(a.created_at)}`,
			a.tags.map((t) => el("span", { className: "tag", textContent: t })),
		),
		el("p", { textContent: a.summary ?? "Résumé indisponible." }),
		el(
			"div",
			{ className: "row-actions" },
			el("a", {
				href: safeUrl(a.url),
				target: "_blank",
				rel: "noopener noreferrer",
				textContent: "Ouvrir l'article ↗",
				onclick: () => {
					if (!a.read_at) update({ read: true })();
				},
			}),
			el("button", { className: "small", textContent: a.favorite ? "★ Favori" : "☆ Favori", ariaPressed: String(a.favorite), onclick: update({ favorite: !a.favorite }) }),
			el("button", { className: "small", textContent: a.read_at ? "Marquer non lu" : "Marquer lu", ariaPressed: String(Boolean(a.read_at)), onclick: update({ read: !a.read_at }) }),
			el("button", { className: "small", textContent: a.dismissed ? "Rétablir (pertinent)" : "Pas pertinent", ariaPressed: String(a.dismissed), onclick: update({ dismissed: !a.dismissed }) }),
		),
		primary && el("p", { className: "muted" }, "Cet article est rattaché à un sujet déjà couvert : ", el("button", { className: "link", style: "font-size:13px", textContent: primary.title, onclick: () => openFiche(primary.id) })),
		coveredBy.length > 0 && el("h3", { textContent: `Même sujet dans ${coveredBy.length} autre(s) article(s)` }),
		coveredBy.length > 0 && el("ul", {}, coveredBy.map(linkTo)),
		el("h3", { textContent: "Articles proches" }),
		related.length ? el("ul", {}, related.map(linkTo)) : el("p", { className: "muted", textContent: "Aucun article proche trouvé." }),
	);
	if (!$("fiche").open) $("fiche").showModal();
}

// ── Tendances ─────────────────────────────────────────────────────────────

const tooltip = el("div", { className: "tooltip", hidden: true });
document.body.append(tooltip);

function showTip(event, text) {
	tooltip.textContent = text;
	tooltip.hidden = false;
	tooltip.style.left = `${Math.min(event.clientX + 12, window.innerWidth - tooltip.offsetWidth - 8)}px`;
	tooltip.style.top = `${event.clientY - 32}px`;
}

/** Petit graphique en ligne d'une série hebdomadaire. Toutes les séries partagent la même échelle. */
function sparkline(name, values, weeks, max) {
	const W = 240, H = 84, left = 6, right = 6, top = 8, bottom = 18;
	const x = (i) => left + (i * (W - left - right)) / Math.max(1, values.length - 1);
	const y = (v) => top + (1 - v / max) * (H - top - bottom);
	const half = Math.floor(values.length / 2);
	const sum = (list) => list.reduce((a, b) => a + b, 0);
	const recent = sum(values.slice(-half));
	const before = sum(values.slice(-2 * half, -half));
	const delta = recent - before;
	const trend = delta > 0 ? `▲ +${delta}` : delta < 0 ? `▼ −${Math.abs(delta)}` : "= stable";

	const chart = svg(
		"svg",
		{ viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${name} : ${values.join(", ")} articles par semaine` },
		svg("line", { class: "axis", x1: left, x2: W - right, y1: y(0), y2: y(0) }),
		svg("polyline", { class: "line", points: values.map((v, i) => `${x(i)},${y(v)}`).join(" ") }),
	);
	values.forEach((v, i) => {
		const hit = svg("circle", { class: "hit", cx: x(i), cy: y(v), r: 10 });
		const text = `${name} — semaine du ${shortDay(weeks[i])} : ${v} article(s)`;
		hit.addEventListener("mousemove", (e) => showTip(e, text));
		hit.addEventListener("mouseleave", () => {
			tooltip.hidden = true;
		});
		chart.append(hit, svg("circle", { class: "dot", cx: x(i), cy: y(v), r: i === values.length - 1 ? 4 : 2.5 }));
	});
	const label = (i, anchor) => {
		const node = svg("text", { x: x(i), y: H - 4, "text-anchor": anchor });
		node.textContent = shortDay(weeks[i]);
		return node;
	};
	chart.append(label(0, "start"), label(values.length - 1, "end"));

	return el(
		"figure",
		{ className: "panel multiple" },
		el(
			"header",
			{},
			el("strong", { textContent: name }),
			el("span", { className: "muted", textContent: `${sum(values)} articles · ${trend}`, title: `${half} dernières semaines comparées aux ${half} précédentes` }),
		),
		chart,
	);
}

async function loadTrends() {
	const [data] = await Promise.all([json(`/trends?weeks=${$("weeks").value}`), stats ? null : loadStats()]);
	const half = Math.floor(data.weeks.length / 2);
	const total = (values) => values.reduce((a, b) => a + b, 0);
	const tags = Object.entries(data.series).sort(([, a], [, b]) => total(b) - total(a));
	const max = Math.max(1, ...tags.flatMap(([, values]) => values));

	$("trends-note").textContent = tags.length
		? `Nombre d'articles par thème et par semaine. Tous les graphiques des thèmes partagent la même échelle (maximum : ${max}). La tendance compare les ${half} dernières semaines aux ${half} précédentes ; la semaine en cours est incomplète.`
		: "Aucun article étiqueté sur cette période. Les articles collectés avant la v2 n'ont pas de thème : lance « npm run requeue » pour les faire étiqueter.";
	$("trend-charts").replaceChildren(
		sparkline("Total", data.total, data.weeks, Math.max(1, ...data.total)),
		...tags.map(([tag, values]) => sparkline(tag, values, data.weeks, max)),
	);
	$("trend-table").replaceChildren(
		table(
			[{ label: "Thème" }, ...data.weeks.map((w) => ({ label: shortDay(w), num: true }))],
			[["Total", ...data.total.map(String)], ...tags.map(([tag, values]) => [tag, ...values.map(String)])],
		),
	);
	bars("chart-source", stats.bySource);
	bars("chart-score", Object.fromEntries([1, 2, 3, 4, 5].map((n) => [n, stats.scoreDistribution[n] ?? 0])), { label: (k) => "★".repeat(k) });
}

// ── Rapport ───────────────────────────────────────────────────────────────

let currentReport = null;

async function loadReports() {
	const reports = await json("/reports");
	$("report-list").replaceChildren(
		...(reports.length
			? reports.map((r) =>
					el("button", {
						className: "report-item",
						ariaPressed: String(currentReport?.id === r.id),
						textContent: `${dayTime(r.created_at)} — ${r.days ? `${r.days} jours` : "toute la veille"} (${r.articles} articles)`,
						onclick: () => attempt(() => showReport(r.id)),
					}),
				)
			: [el("p", { className: "muted", textContent: "Aucun rapport pour l'instant." })]),
	);
}

async function showReport(id) {
	currentReport = await json(`/reports/${id}`);
	const filename = `rapport_veille_${currentReport.created_at.slice(0, 10)}.md`;
	$("report-view").replaceChildren(
		el(
			"div",
			{ className: "row-actions" },
			el("button", { textContent: "Télécharger en Markdown", onclick: () => saveBlob(new Blob([currentReport.content], { type: "text/markdown" }), filename) }),
			el("button", {
				textContent: "Copier",
				onclick: (e) => attempt(async () => {
					await navigator.clipboard.writeText(currentReport.content);
					e.target.textContent = "Copié";
				}),
			}),
			el("button", {
				textContent: "Supprimer",
				onclick: () => attempt(async () => {
					if (!confirm("Supprimer ce rapport ?")) return;
					await json(`/reports/${currentReport.id}`, { method: "DELETE" });
					currentReport = null;
					$("report-view").replaceChildren(el("p", { className: "muted", textContent: "Rapport supprimé." }));
					await loadReports();
				}),
			}),
		),
		markdown(currentReport.content),
	);
	await loadReports();
}

async function generateReport(event) {
	event.preventDefault();
	const button = $("report-generate");
	button.disabled = true;
	button.textContent = "Analyse en cours… (jusqu'à une minute)";
	await attempt(async () => {
		const value = $("report-days").value;
		const report = await json("/reports", { method: "POST", body: { days: value ? Number(value) : null } });
		await showReport(report.id);
	});
	button.disabled = false;
	button.textContent = "Générer un rapport";
}

// ── Sources ───────────────────────────────────────────────────────────────

const CATEGORY_LABELS = { web: "Web", ia: "IA", communaute: "Communauté", infra: "Infra / sécurité" };

function sourceHealth(s) {
	if (s.status !== "active") return "Désactivée";
	if (s.failures > 0) return `En erreur (${s.failures} échec(s) de suite)`;
	return s.last_success_at ? "OK" : "Jamais lue";
}

async function loadSources() {
	const { sources, categories, suggestions } = await json("/sources");
	if ($("source-category").options.length === 0) {
		$("source-category").append(...categories.map((c) => el("option", { value: c, textContent: CATEGORY_LABELS[c] ?? c })));
	}
	const setStatus = (s, status) => () =>
		attempt(async () => {
			await json(`/sources/${s.id}`, { method: "PATCH", body: { status } });
			await Promise.all([loadSources(), loadStats()]);
		});
	const remove = (s) => () =>
		attempt(async () => {
			if (!confirm(`Supprimer « ${s.name} » ? Les articles déjà collectés sont conservés.`)) return;
			await json(`/sources/${s.id}`, { method: "DELETE" });
			await Promise.all([loadSources(), loadStats()]);
		});
	const identity = (s) => [
		el("strong", { textContent: s.name }),
		el("a", { className: "muted url", href: safeUrl(s.url), target: "_blank", rel: "noopener noreferrer", textContent: s.url }),
	];

	// Propositions en attente de validation.
	const suggested = sources.filter((s) => s.status === "suggested");
	$("suggestions").replaceChildren(
		...suggested.map((s) =>
			el(
				"div",
				{ className: "suggestion" },
				el("div", {}, ...identity(s), el("div", {}, `${stars(s.ai_score ?? 0)} — ${s.note ?? ""}`), el("div", { className: "muted", textContent: `${CATEGORY_LABELS[s.category] ?? s.category} · ${s.lang === "fr" ? "français" : "anglais"} · flux vérifié le ${day(s.created_at)}` })),
				el("div", { className: "row-actions" }, el("button", { className: "primary small", textContent: "Suivre", onclick: setStatus(s, "active") }), el("button", { className: "small", textContent: "Refuser", onclick: setStatus(s, "rejected") })),
			),
		),
	);

	// État de la dernière recherche.
	const job = suggestions;
	$("suggest").disabled = job.running;
	$("suggest").textContent = job.running ? "Recherche en cours…" : "Chercher de nouvelles sources";
	const lines = [];
	if (job.running) lines.push("Lecture et évaluation des flux proposés : cela prend environ une minute.");
	else if (job.error) lines.push(job.error);
	else if (job.report) {
		const r = job.report;
		lines.push(`Dernière recherche (${dayTime(job.finishedAt)}) : ${r.proposed} flux proposés, ${r.added.length} retenu(s), ${r.discarded.length} écarté(s).`);
		for (const d of r.discarded) lines.push(`✕ ${d.name} — ${d.reason}`);
	} else if (suggested.length === 0) lines.push("Aucune proposition en attente.");
	$("suggest-status").replaceChildren(...lines.map((line) => el("div", { textContent: line })));
	clearTimeout(suggestTimer);
	if (job.running) suggestTimer = setTimeout(() => currentView() === "sources" && attempt(loadSources).then(loadStats), 4000);

	// Sources suivies ou désactivées.
	const followed = sources.filter((s) => s.status === "active" || s.status === "disabled");
	$("source-table").replaceChildren(
		table(
			[{ label: "Source" }, { label: "Catégorie" }, { label: "État" }, { label: "Dernière lecture réussie" }, { label: "Articles du flux", num: true }, { label: "Actions" }],
			followed.map((s) => [
				el("div", {}, ...identity(s)),
				`${CATEGORY_LABELS[s.category] ?? s.category} · ${s.lang}`,
				el("div", {}, sourceHealth(s), s.failures > 0 && s.last_error ? el("span", { className: "muted", textContent: s.last_error }) : null),
				dayTime(s.last_success_at),
				s.last_item_count === null ? "—" : String(s.last_item_count),
				el(
					"div",
					{ className: "row-actions" },
					s.status === "active"
						? el("button", { className: "small", textContent: "Désactiver", onclick: setStatus(s, "disabled") })
						: el("button", { className: "small", textContent: "Activer", onclick: setStatus(s, "active") }),
					el("button", { className: "small", textContent: "Supprimer", onclick: remove(s) }),
				),
			]),
			"Aucune source suivie.",
		),
	);

	const rejected = sources.filter((s) => s.status === "rejected");
	$("rejected-box").hidden = rejected.length === 0;
	$("rejected-table").replaceChildren(
		table(
			[{ label: "Source" }, { label: "Avis de l'IA" }, { label: "Actions" }],
			rejected.map((s) => [
				el("div", {}, ...identity(s)),
				s.note ?? "—",
				el("div", { className: "row-actions" }, el("button", { className: "small", textContent: "Suivre quand même", onclick: setStatus(s, "active") }), el("button", { className: "small", textContent: "Oublier", onclick: remove(s) })),
			]),
		),
	);
}

async function addSource(event) {
	event.preventDefault();
	const button = event.submitter;
	button.disabled = true;
	button.textContent = "Lecture du flux…";
	await attempt(async () => {
		const source = await json("/sources", {
			method: "POST",
			body: { url: $("source-url").value.trim(), name: $("source-name").value.trim() || undefined, category: $("source-category").value, lang: $("source-lang").value },
		});
		$("source-form").reset();
		await Promise.all([loadSources(), loadStats()]);
		notify(`Source ajoutée : ${source.name} (${source.url}). Elle sera lue à la prochaine collecte.`);
	});
	button.disabled = false;
	button.textContent = "Vérifier et ajouter";
}

// ── Système ───────────────────────────────────────────────────────────────

const PURPOSES = { enrich: "Résumés des articles", ask: "Questions (/ask)", analyze: "Analyses et rapports", sources: "Propositions de sources", other: "Autre" };

async function loadSystem() {
	const s = await json("/system");
	const tile = (value, label, small) =>
		el("div", { className: "panel tile" }, el("b", { className: small ? "small" : "", textContent: String(value) }), el("span", { className: "muted", textContent: label }));
	const failing = s.sources.filter((x) => x.status === "active" && x.failures > 0).length;
	$("system-tiles").replaceChildren(
		tile(s.llm ?? "non configurée", "modèle d'IA", true),
		tile(money(s.usage.month.cost), "coût de l'IA ce mois-ci"),
		tile(money(s.usage.today.cost), "coût de l'IA aujourd'hui"),
		tile(s.scheduler.collecting ? "en cours" : dayTime(s.scheduler.nextRunAt), "prochaine collecte", true),
		tile(`${s.articles.pending} / ${s.articles.failed}`, "articles en attente / en échec"),
		tile(failing, "source(s) en erreur"),
	);

	$("usage-table").replaceChildren(
		table(
			[{ label: "Usage" }, { label: "Appels", num: true }, { label: "Tokens lus", num: true }, { label: "Tokens écrits", num: true }, { label: "Coût", num: true }],
			[...s.usage.byPurpose, { ...s.usage.month, purpose: "total" }].map((u) => [
				u.purpose === "total" ? el("strong", { textContent: "Total du mois" }) : (PURPOSES[u.purpose] ?? u.purpose),
				count(u.calls),
				count(u.prompt_tokens),
				count(u.completion_tokens),
				money(u.cost),
			]),
		),
	);
	$("usage-note").textContent = `Estimation au prix de ${s.usage.price.input} $ (lecture) et ${s.usage.price.output} $ (écriture) par million de tokens — réglable avec LLM_PRICE_INPUT et LLM_PRICE_OUTPUT. Le montant facturé par le fournisseur fait foi.`;
	bars("chart-cost", Object.fromEntries(s.usage.byDay.map((d) => [d.day, d.cost])), { limit: 30, label: shortDay, value: money, unit: "" });

	$("runs-table").replaceChildren(
		table(
			[{ label: "Début" }, { label: "État" }, { label: "Lus", num: true }, { label: "Nouveaux", num: true }, { label: "Résumés", num: true }, { label: "Doublons", num: true }, { label: "Échecs", num: true }, { label: "Notifiés", num: true }, { label: "Tokens", num: true }, { label: "Sources en échec" }],
			s.runs.map((r) => [
				dayTime(r.started_at),
				r.error ? `Erreur : ${r.error}` : r.finished_at ? "Terminée" : "En cours ou interrompue",
				String(r.fetched),
				String(r.inserted),
				String(r.enriched),
				String(r.duplicates),
				String(r.failed),
				String(r.notified),
				count(r.prompt_tokens + r.completion_tokens),
				r.sources_failed.join(", ") || "—",
			]),
			"Aucune collecte enregistrée.",
		),
	);

	const yes = (value) => (value ? "oui" : "non");
	const config = [
		["En ligne depuis", dayTime(s.startedAt)],
		["Collectes effectuées", count(s.runCount)],
		["Fréquence", `toutes les ${s.scheduler.intervalMinutes} min, de ${s.scheduler.activeHours.start} h à ${s.scheduler.activeHours.end} h (Paris)`],
		["Articles par source et par collecte", s.scheduler.itemsPerSource],
		["Résumés max par collecte", s.scheduler.maxEnrichPerRun],
		["Score minimal pour notifier", s.scheduler.notifyMinScore],
		["Bot Telegram", yes(s.features.telegram)],
		["Notifications Telegram", yes(s.features.notifications)],
		["Digest hebdomadaire", yes(s.features.weeklyDigest)],
		["Recherche web (Tavily)", yes(s.features.webSearch)],
		["Endpoint MCP protégé par jeton", yes(s.features.mcpProtected)],
	];
	$("system-config").replaceChildren(el("dl", { className: "config" }, config.flatMap(([k, v]) => [el("dt", { textContent: k }), el("dd", { textContent: String(v) })])));
	$("events").replaceChildren(...(s.events.length ? s.events : ["Aucun événement depuis le démarrage."]).map((e) => el("li", { textContent: e })));
}

// ── Démarrage ─────────────────────────────────────────────────────────────

async function start() {
	if (!session.get()) return showLogin();
	try {
		await loadStats();
	} catch (err) {
		if (err.message !== "401") showLogin("Serveur injoignable.");
		return;
	}
	$("login").hidden = true;
	$("app").hidden = false;
	await route();
}

$("login").addEventListener("submit", (e) => {
	e.preventDefault();
	session.set($("token").value.trim());
	start();
});
$("logout").addEventListener("click", () => {
	session.set(null);
	showLogin();
});
$("filters").addEventListener("submit", (e) => {
	e.preventDefault();
	page = 1;
	attempt(loadArticles);
});
for (const id of ["favorite", "unread", "dismissed", "tag", "source", "min_score"]) {
	$(id).addEventListener("change", () => {
		page = 1;
		attempt(loadArticles);
	});
}
$("export-md").addEventListener("click", () => attempt(() => download("md")));
$("export-csv").addEventListener("click", () => attempt(() => download("csv")));
$("collect").addEventListener("click", () =>
	attempt(async () => {
		const res = await api("/collect", { method: "POST" });
		$("status").textContent = res.status === 202 ? "Collecte lancée…" : "Collecte déjà en cours…";
	}),
);
$("weeks").addEventListener("change", () => attempt(loadTrends));
$("report-form").addEventListener("submit", generateReport);
$("source-form").addEventListener("submit", addSource);
$("suggest").addEventListener("click", () =>
	attempt(async () => {
		await json("/sources/suggest", { method: "POST" });
		await loadSources();
	}),
);
$("fiche").addEventListener("click", (e) => {
	if (e.target === $("fiche")) $("fiche").close();
});
window.addEventListener("hashchange", route);
start();
