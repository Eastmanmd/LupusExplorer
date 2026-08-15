/* Lupus Gene Tracker — static dashboard over pipeline-generated JSON. */
"use strict";

const state = {
  genes: [],
  geneBySymbol: new Map(),
  articles: new Map(),
  pathways: [],
  pathwayById: new Map(),
  meta: null,
  compare: [],          // symbols, max 3
  pathwaySource: "all",
  compareAsTable: false,
};

const SOURCE_LABELS = { "GO:BP": "GO Biological Process", KEGG: "KEGG", REAC: "Reactome" };
const SOURCE_COLORS = { "GO:BP": "var(--series-1)", KEGG: "var(--series-2)", REAC: "var(--series-3)" };
const SERIES_VARS = ["--series-1", "--series-2", "--series-3"];

/* ---------- tiny DOM helpers (textContent only — data is untrusted) ---------- */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(child));
  }
  return node;
}
function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const child of children) node.append(child);
  return node;
}
function fmt(n) { return n.toLocaleString("en-US"); }

/* ---------- tooltip ---------- */
const tooltip = document.getElementById("tooltip");
function showTooltip(x, y, title, rows) {
  tooltip.replaceChildren(
    el("div", { class: "tt-title" }, title),
    ...rows.map(r => el("div", { class: "tt-row" },
      r.color ? el("span", { class: "tt-key", style: `border-top-color:${r.color}` }) : null,
      el("span", { class: "tt-val" }, r.value),
      el("span", { class: "tt-label" }, r.label))),
  );
  tooltip.hidden = false;
  const rect = tooltip.getBoundingClientRect();
  const left = Math.min(x + 14, window.innerWidth - rect.width - 8);
  const top = Math.min(y + 14, window.innerHeight - rect.height - 8);
  tooltip.style.left = `${Math.max(8, left)}px`;
  tooltip.style.top = `${Math.max(8, top)}px`;
}
function hideTooltip() { tooltip.hidden = true; }

/* ---------- charts ---------- */
function sparkline(gene, width = 110, height = 26) {
  const end = state.meta.max_year;
  const start = end - 11;
  const values = [];
  for (let y = start; y <= end; y++) values.push(gene.year_counts[y] || 0);
  const max = Math.max(...values, 1);
  const px = i => 2 + (i * (width - 8)) / (values.length - 1);
  const py = v => height - 3 - (v * (height - 8)) / max;
  const d = values.map((v, i) => `${i ? "L" : "M"}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join("");
  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, width, height,
    role: "img", "aria-label": `Papers per year, ${start}–${end}: ${values.join(", ")}` });
  svg.append(
    svgEl("path", { d, fill: "none", stroke: "var(--muted)", "stroke-width": 1.5,
      "stroke-linejoin": "round", "stroke-linecap": "round" }),
    svgEl("circle", { cx: px(values.length - 1), cy: py(values.at(-1)), r: 2.5, fill: "var(--series-1)" }),
  );
  return svg;
}

function niceTicks(max, count = 4) {
  if (max <= 0) return [0, 1];
  const step = Math.pow(10, Math.floor(Math.log10(max / count)));
  const candidates = [step, 2 * step, 2.5 * step, 5 * step, 10 * step];
  const chosen = candidates.find(s => max / s <= count) || 10 * step;
  const ticks = [];
  for (let v = 0; v <= max + 1e-9; v += chosen) ticks.push(Math.round(v * 100) / 100);
  return ticks;
}

/* Column chart of papers per year with per-bar hover tooltip. */
function yearColumnChart(yearCounts, { label }) {
  const years = Object.keys(yearCounts).map(Number).sort((a, b) => a - b);
  if (!years.length) return el("p", { class: "muted" }, "No dated articles.");
  const start = Math.min(years[0], state.meta.max_year - 9);
  const end = state.meta.max_year;
  const data = [];
  for (let y = start; y <= end; y++) data.push({ year: y, value: yearCounts[y] || 0 });
  const W = 900, H = 220, padL = 40, padR = 10, padT = 12, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxV = Math.max(...data.map(d => d.value), 1);
  const ticks = niceTicks(maxV);
  const yMax = ticks.at(-1);
  const band = plotW / data.length;
  const barW = Math.min(24, Math.max(2, band - 2));
  const py = v => padT + plotH - (v / yMax) * plotH;

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": label });
  for (const t of ticks) {
    if (t > 0) svg.append(svgEl("line", { class: "gridline", x1: padL, x2: W - padR, y1: py(t), y2: py(t) }));
    svg.append(svgEl("text", { class: "tick-label", x: padL - 6, y: py(t) + 3.5, "text-anchor": "end" }, fmt(t)));
  }
  svg.append(svgEl("line", { class: "baseline-rule", x1: padL, x2: W - padR, y1: py(0), y2: py(0) }));
  const labelEvery = Math.ceil(data.length / 12);
  data.forEach((d, i) => {
    const cx = padL + band * i + band / 2;
    if (i % labelEvery === 0) {
      svg.append(svgEl("text", { class: "tick-label", x: cx, y: H - 8, "text-anchor": "middle" }, d.year));
    }
    if (d.value > 0) {
      const x = cx - barW / 2, y = py(d.value), h = py(0) - y;
      const r = Math.min(4, barW / 2, h);
      svg.append(svgEl("path", {
        d: `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + barW - r},${y} Q${x + barW},${y} ${x + barW},${y + r} L${x + barW},${y + h} Z`,
        fill: "var(--series-1)",
      }));
    }
    const hit = svgEl("rect", { x: padL + band * i, y: padT, width: band, height: plotH + padB, fill: "transparent" });
    hit.addEventListener("pointermove", ev =>
      showTooltip(ev.clientX, ev.clientY, String(d.year),
        [{ value: fmt(d.value), label: d.value === 1 ? "paper" : "papers", color: "var(--series-1)" }]));
    hit.addEventListener("pointerleave", hideTooltip);
    svg.append(hit);
  });
  return el("div", { class: "chart-box" }, svg);
}

/* Multi-series line chart with crosshair + all-series tooltip. */
function trendLineChart(seriesList) {
  const start = Math.min(...seriesList.map(s => {
    const ys = Object.keys(s.yearCounts).map(Number);
    return ys.length ? Math.min(...ys) : state.meta.max_year;
  }), state.meta.max_year - 9);
  const end = state.meta.max_year;
  const years = [];
  for (let y = Math.max(start, 1975); y <= end; y++) years.push(y);
  const W = 900, H = 280, padL = 40, padR = 70, padT = 12, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxV = Math.max(1, ...seriesList.flatMap(s => years.map(y => s.yearCounts[y] || 0)));
  const ticks = niceTicks(maxV);
  const yMax = ticks.at(-1);
  const px = i => padL + (years.length === 1 ? plotW / 2 : (i * plotW) / (years.length - 1));
  const py = v => padT + plotH - (v / yMax) * plotH;

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img",
    "aria-label": `Papers per year for ${seriesList.map(s => s.name).join(", ")}` });
  for (const t of ticks) {
    if (t > 0) svg.append(svgEl("line", { class: "gridline", x1: padL, x2: W - padR, y1: py(t), y2: py(t) }));
    svg.append(svgEl("text", { class: "tick-label", x: padL - 6, y: py(t) + 3.5, "text-anchor": "end" }, fmt(t)));
  }
  svg.append(svgEl("line", { class: "baseline-rule", x1: padL, x2: W - padR, y1: py(0), y2: py(0) }));
  const labelEvery = Math.ceil(years.length / 12);
  years.forEach((y, i) => {
    if (i % labelEvery === 0) {
      svg.append(svgEl("text", { class: "tick-label", x: px(i), y: H - 8, "text-anchor": "middle" }, y));
    }
  });
  seriesList.forEach((s, si) => {
    const color = `var(${SERIES_VARS[si]})`;
    const d = years.map((y, i) => `${i ? "L" : "M"}${px(i).toFixed(1)},${py(s.yearCounts[y] || 0).toFixed(1)}`).join("");
    svg.append(svgEl("path", { d, fill: "none", stroke: color, "stroke-width": 2,
      "stroke-linejoin": "round", "stroke-linecap": "round" }));
    const lastY = py(s.yearCounts[end] || 0);
    svg.append(svgEl("circle", { cx: px(years.length - 1), cy: lastY, r: 4, fill: color,
      stroke: "var(--surface)", "stroke-width": 2 }));
    const lbl = svgEl("text", { class: "direct-label", x: px(years.length - 1) + 9, y: lastY + 4 }, s.name);
    svg.append(lbl);
  });
  // de-collide end labels
  const labels = [...svg.querySelectorAll(".direct-label")]
    .sort((a, b) => +a.getAttribute("y") - +b.getAttribute("y"));
  for (let i = 1; i < labels.length; i++) {
    const prev = +labels[i - 1].getAttribute("y"), cur = +labels[i].getAttribute("y");
    if (cur - prev < 13) labels[i].setAttribute("y", prev + 13);
  }

  const crosshair = svgEl("line", { class: "crosshair", y1: padT, y2: padT + plotH, visibility: "hidden" });
  svg.append(crosshair);
  const hit = svgEl("rect", { x: padL, y: padT, width: plotW, height: plotH + padB, fill: "transparent" });
  hit.addEventListener("pointermove", ev => {
    const rect = svg.getBoundingClientRect();
    const sx = ((ev.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(years.length - 1,
      Math.round(((sx - padL) / plotW) * (years.length - 1))));
    crosshair.setAttribute("x1", px(i));
    crosshair.setAttribute("x2", px(i));
    crosshair.setAttribute("visibility", "visible");
    showTooltip(ev.clientX, ev.clientY, String(years[i]),
      seriesList.map((s, si) => ({
        value: fmt(s.yearCounts[years[i]] || 0), label: s.name, color: `var(${SERIES_VARS[si]})`,
      })));
  });
  hit.addEventListener("pointerleave", () => {
    crosshair.setAttribute("visibility", "hidden");
    hideTooltip();
  });
  svg.append(hit);
  return el("div", { class: "chart-box" }, svg);
}

/* ---------- KPI row ---------- */
function renderKPIs() {
  const m = state.meta;
  const topGene = state.genes[0];
  const rising = state.genes.filter(g => g.rising).length;
  document.getElementById("kpi-row").replaceChildren(
    statTile("Lupus articles in corpus", fmt(m.corpus_articles), `PubMed query, through ${m.max_year}`),
    statTile("Genes ranked", fmt(m.genes_ranked), `top ${fmt(m.genes_shown)} shown`),
    statTile("Top gene", topGene.symbol, `score ${topGene.score} · ${fmt(topGene.papers)} papers`),
    statTile("Rising genes", fmt(rising), `recent-5-yr share ≥ 1.5× corpus`),
  );
}
function statTile(label, value, sub) {
  return el("div", { class: "stat-tile" },
    el("div", { class: "label" }, label),
    el("div", { class: "value" }, value),
    el("div", { class: "sub" }, sub));
}

/* ---------- gene leaderboard ---------- */
const genesFilter = { q: "", risingOnly: false, geneticOnly: false };

function renderGenesView() {
  const view = document.getElementById("view-genes");
  const search = el("input", { type: "search", placeholder: "Search gene symbol or name…",
    value: genesFilter.q, oninput: e => { genesFilter.q = e.target.value; renderGeneTable(); } });
  const rising = el("input", { type: "checkbox", onchange: e => { genesFilter.risingOnly = e.target.checked; renderGeneTable(); } });
  rising.checked = genesFilter.risingOnly;
  const genetic = el("input", { type: "checkbox", onchange: e => { genesFilter.geneticOnly = e.target.checked; renderGeneTable(); } });
  genetic.checked = genesFilter.geneticOnly;
  view.replaceChildren(
    el("div", { class: "filter-row" },
      search,
      el("label", { class: "check" }, rising, "Rising only"),
      el("label", { class: "check" }, genetic, "Genetic evidence only"),
      el("span", { class: "count", id: "gene-count" })),
    el("div", { class: "card" },
      el("table", { class: "data" },
        el("thead", {}, el("tr", {},
          el("th", { class: "num" }, "#"),
          el("th", {}, "Gene"),
          el("th", {}, "Combined score"),
          el("th", { class: "num" }, "Papers"),
          el("th", { class: "num" }, "Last 5 yr"),
          el("th", {}, `Trend ${state.meta.max_year - 11}–${state.meta.max_year}`),
          el("th", {}, "Evidence"))),
        el("tbody", { id: "gene-tbody" }))),
  );
  renderGeneTable();
}

function renderGeneTable() {
  const q = genesFilter.q.trim().toLowerCase();
  const rows = state.genes.filter(g =>
    (!q || g.symbol.toLowerCase().includes(q) || g.name.toLowerCase().includes(q)) &&
    (!genesFilter.risingOnly || g.rising) &&
    (!genesFilter.geneticOnly || g.ot_genetic >= 0.2));
  document.getElementById("gene-count").textContent = `${rows.length} genes`;
  const maxScore = state.genes[0].score;
  document.getElementById("gene-tbody").replaceChildren(...rows.map(g =>
    el("tr", { class: "gene-row", tabindex: "0", role: "button",
      onclick: () => showDetail(g.symbol),
      onkeydown: ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); showDetail(g.symbol); } } },
      el("td", { class: "num muted" }, String(g.rank)),
      el("td", {},
        el("div", { class: "gene-symbol" }, g.symbol),
        el("div", { class: "gene-name" }, g.name)),
      el("td", {}, el("div", { class: "score-cell" },
        el("div", { class: "bar-track" },
          el("div", { class: "bar-fill", style: `width:${(g.score / maxScore) * 100}%` })),
        el("span", { class: "val" }, g.score.toFixed(1)))),
      el("td", { class: "num" }, fmt(g.papers)),
      el("td", { class: "num" }, fmt(g.recent_papers)),
      el("td", {}, sparkline(g)),
      el("td", {},
        g.ot_genetic >= 0.2 ? el("span", { class: "badge genetic", title: `Open Targets genetic association ${g.ot_genetic.toFixed(2)}` }, "genetic") : null,
        g.rising ? el("span", { class: "badge rising" }, "rising ↑") : null)),
  ));
}

/* ---------- gene detail ---------- */
function showDetail(symbol) {
  const g = state.geneBySymbol.get(symbol);
  if (!g) return;
  history.replaceState(null, "", `#gene=${encodeURIComponent(symbol)}`);
  const view = document.getElementById("view-detail");
  const w = state.meta.weights;
  const components = [
    { label: `Mentions (×${w.mentions})`, value: g.mention_norm, color: "var(--seq-450)" },
    { label: `Recency (×${w.recency})`, value: g.recency_norm, color: "var(--seq-250)" },
    { label: `Open Targets (×${w.opentargets})`, value: g.ot_score, color: "var(--seq-150)" },
  ];
  const articles = g.article_pmids.map(p => state.articles.get(p)).filter(Boolean);
  const pathwayChips = g.pathways
    .map(id => state.pathwayById.get(id)).filter(Boolean)
    .map(t => el("button", { class: "chip", onclick: () => { showPathways(t.source); } },
      t.name, el("span", { class: "src" }, t.source)));

  view.replaceChildren(
    el("button", { class: "back-btn", onclick: () => switchView("genes") }, "← Back to leaderboard"),
    el("div", { class: "detail-head" },
      el("h2", {}, g.symbol),
      el("span", { class: "muted" }, g.name),
      el("a", { href: `https://www.ncbi.nlm.nih.gov/gene/${g.entrez}`, target: "_blank", rel: "noopener" }, "NCBI Gene ↗")),
    el("div", { class: "kpi-row" },
      statTile("Combined score", g.score.toFixed(1), `rank #${g.rank} of ${fmt(state.meta.genes_shown)}`),
      statTile("Lupus papers", fmt(g.papers), "all years"),
      statTile("Last 5 years", fmt(g.recent_papers), g.rising ? "rising ↑" : "papers since " + state.meta.recent_cutoff),
      statTile("Open Targets", g.ot_score.toFixed(2), `genetic ${g.ot_genetic.toFixed(2)}`)),
    el("div", { class: "card" },
      el("h2", {}, "Score breakdown"),
      el("p", { class: "sub" }, "Each component is normalized 0–1; the combined score is the weighted sum × 100."),
      ...components.map(c => el("div", { class: "breakdown-row" },
        el("span", {}, c.label),
        el("div", { class: "track" }, el("div", { class: "fill", style: `width:${c.value * 100}%;background:${c.color}` })),
        el("span", { class: "num" }, c.value.toFixed(2))))),
    el("div", { class: "card" },
      el("h2", {}, "Lupus papers mentioning " + g.symbol + " per year"),
      el("p", { class: "sub" }, "Gene mentions from PubTator 3 annotations across the lupus corpus."),
      yearColumnChart(g.year_counts, { label: `Papers per year mentioning ${g.symbol}` })),
    el("div", { class: "card" },
      el("h2", {}, "Pathways"),
      el("p", { class: "sub" }, "Enriched GO-BP / KEGG / Reactome terms (top-gene set) containing this gene."),
      pathwayChips.length ? el("div", {}, ...pathwayChips) : el("p", { class: "muted" }, "Not a member of any enriched term.")),
    el("div", { class: "card" },
      el("h2", {}, `Recent articles (${articles.length})`),
      el("p", { class: "sub" }, "Most recent lupus articles mentioning this gene; titles link to PubMed."),
      el("table", { class: "data" },
        el("thead", {}, el("tr", {},
          el("th", { class: "num" }, "Year"), el("th", {}, "Title"), el("th", {}, "Journal"))),
        el("tbody", {}, ...articles.map(a => el("tr", {},
          el("td", { class: "num muted" }, a.year ? String(a.year) : "—"),
          el("td", {}, el("a", { href: `https://pubmed.ncbi.nlm.nih.gov/${a.pmid}/`, target: "_blank", rel: "noopener" },
            a.title || `PMID ${a.pmid}`)),
          el("td", { class: "muted" }, a.journal)))))),
  );
  switchView("detail", { keepHash: true });
  window.scrollTo({ top: 0 });
}

/* ---------- pathways ---------- */
function showPathways(source) {
  state.pathwaySource = source || "all";
  switchView("pathways");
}

function renderPathwaysView() {
  const view = document.getElementById("view-pathways");
  if (!state.pathways.length) {
    view.replaceChildren(el("p", { class: "muted" }, "No enrichment results yet — run the pipeline's enrichment step."));
    return;
  }
  const sources = ["all", "GO:BP", "KEGG", "REAC"];
  const select = el("select", { onchange: e => { state.pathwaySource = e.target.value; renderPathwaysView(); } },
    ...sources.map(s => {
      const o = el("option", { value: s }, s === "all" ? "All sources" : SOURCE_LABELS[s]);
      if (s === state.pathwaySource) o.selected = true;
      return o;
    }));
  const shown = state.pathways
    .filter(t => state.pathwaySource === "all" || t.source === state.pathwaySource)
    .sort((a, b) => a.p_value - b.p_value)
    .slice(0, state.pathwaySource === "all" ? 45 : 40);
  const maxLog = Math.max(...shown.map(t => -Math.log10(t.p_value)));

  view.replaceChildren(
    el("div", { class: "filter-row" }, select,
      el("span", { class: "count" }, `${shown.length} terms`)),
    el("div", { class: "legend" },
      ...Object.entries(SOURCE_LABELS).map(([s, label]) =>
        el("span", {}, el("span", { class: "swatch", style: `background:${SOURCE_COLORS[s]}` }), label))),
    el("div", { class: "card" },
      el("h2", {}, "Enriched pathways in the top lupus genes"),
      el("p", { class: "sub" }, "Bar length = −log₁₀(adjusted p) from g:Profiler over the top-ranked genes. Click a term to see its genes."),
      ...shown.map(t => pathwayRow(t, maxLog))),
  );
}

function pathwayRow(term, maxLog) {
  const logP = -Math.log10(term.p_value);
  const row = el("div", { class: "pathway-bar-row", role: "button", tabindex: "0" },
    el("span", { class: "term", title: `${term.id} — ${term.name}` }, term.name),
    el("div", { class: "track" },
      el("div", { class: "fill", style: `width:${(logP / maxLog) * 100}%;background:${SOURCE_COLORS[term.source]}` })),
    el("span", { class: "num" }, logP.toFixed(1)));
  const wrap = el("div", {}, row);
  let open = false;
  const toggle = () => {
    open = !open;
    if (open) {
      wrap.append(el("div", { class: "pathway-members" },
        el("span", { class: "muted" }, `${term.genes.length} of the top genes (${term.intersection_size} matched overall, term size ${fmt(term.term_size)}): `),
        ...term.genes.map(s => el("button", { class: "chip", onclick: () => showDetail(s) }, s))));
    } else {
      wrap.querySelector(".pathway-members")?.remove();
    }
  };
  row.addEventListener("click", toggle);
  row.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); } });
  row.addEventListener("pointermove", ev =>
    showTooltip(ev.clientX, ev.clientY, `${term.id} (${SOURCE_LABELS[term.source]})`, [
      { value: term.p_value.toExponential(1), label: "adjusted p" },
      { value: String(term.genes.length), label: "top genes in term" },
    ]));
  row.addEventListener("pointerleave", hideTooltip);
  return wrap;
}

/* ---------- compare ---------- */
function renderCompareView() {
  const view = document.getElementById("view-compare");
  if (!state.compare.length) state.compare = state.genes.slice(0, 3).map(g => g.symbol);
  const datalist = el("datalist", { id: "gene-options" },
    ...state.genes.map(g => el("option", { value: g.symbol })));
  const input = el("input", { type: "search", list: "gene-options",
    placeholder: state.compare.length >= 3 ? "Remove a gene to add another" : "Add gene (max 3)…",
    onchange: e => {
      const sym = e.target.value.trim().toUpperCase();
      if (state.geneBySymbol.has(sym) && !state.compare.includes(sym) && state.compare.length < 3) {
        state.compare.push(sym);
        renderCompareView();
      }
      e.target.value = "";
    } });
  if (state.compare.length >= 3) input.disabled = true;

  const chips = state.compare.map((sym, i) => el("span", { class: "selected-gene" },
    el("span", { class: "dot", style: `background:var(${SERIES_VARS[i]})` }),
    sym,
    el("button", { "aria-label": `Remove ${sym}`,
      onclick: () => { state.compare = state.compare.filter(s => s !== sym); renderCompareView(); } }, "✕")));

  const seriesList = state.compare.map(sym => ({
    name: sym, yearCounts: state.geneBySymbol.get(sym).year_counts,
  }));

  const body = [];
  if (seriesList.length) {
    body.push(
      el("div", { class: "legend" }, ...state.compare.map((sym, i) =>
        el("span", {}, el("span", { class: "key", style: `border-top-color:var(${SERIES_VARS[i]})` }), sym))),
      trendLineChart(seriesList),
      el("button", { class: "table-toggle",
        onclick: () => { state.compareAsTable = !state.compareAsTable; renderCompareView(); } },
        state.compareAsTable ? "Hide data table" : "Show data table"),
    );
    if (state.compareAsTable) body.push(compareTable(seriesList));
  } else {
    body.push(el("p", { class: "muted" }, "Add genes above to compare their publication trends."));
  }

  view.replaceChildren(
    el("div", { class: "compare-picker" }, ...chips, input, datalist),
    el("div", { class: "card" },
      el("h2", {}, "Lupus papers per year"),
      el("p", { class: "sub" }, "Publication trend comparison across the lupus corpus (PubTator 3 gene mentions)."),
      ...body),
  );
}

function compareTable(seriesList) {
  const end = state.meta.max_year;
  const years = [];
  for (let y = end - 19; y <= end; y++) years.push(y);
  return el("table", { class: "data" },
    el("thead", {}, el("tr", {},
      el("th", {}, "Year"),
      ...seriesList.map(s => el("th", { class: "num" }, s.name)))),
    el("tbody", {}, ...years.map(y => el("tr", {},
      el("td", { class: "muted num" }, String(y)),
      ...seriesList.map(s => el("td", { class: "num" }, fmt(s.yearCounts[y] || 0)))))));
}

/* ---------- view switching ---------- */
function switchView(name, { keepHash } = {}) {
  for (const tab of document.querySelectorAll(".tab")) {
    const active = tab.dataset.view === name;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  }
  for (const v of ["genes", "pathways", "compare", "detail"]) {
    document.getElementById(`view-${v}`).hidden = v !== name;
  }
  if (!keepHash) history.replaceState(null, "", location.pathname + location.search);
  if (name === "genes") renderGenesView();
  if (name === "pathways") renderPathwaysView();
  if (name === "compare") renderCompareView();
}

/* ---------- boot ---------- */
async function boot() {
  const [genes, articles, pathways, meta] = await Promise.all(
    ["genes", "articles", "pathways", "meta"].map(name =>
      fetch(`data/${name}.json`).then(r => {
        if (!r.ok) throw new Error(`${name}.json: HTTP ${r.status}`);
        return r.json();
      })));
  state.genes = genes.genes;
  state.meta = meta;
  state.pathways = pathways.pathways;
  for (const g of state.genes) state.geneBySymbol.set(g.symbol, g);
  for (const a of articles.articles) state.articles.set(a.pmid, a);
  for (const t of state.pathways) state.pathwayById.set(t.id, t);

  document.getElementById("loading").remove();
  document.getElementById("provenance").textContent =
    `Last updated ${meta.updated} · ${fmt(meta.corpus_articles)} articles · query: ${meta.query}`;
  renderKPIs();
  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => switchView(tab.dataset.view));
  }
  const hashGene = new URLSearchParams(location.hash.slice(1)).get("gene");
  if (hashGene && state.geneBySymbol.has(hashGene)) showDetail(hashGene);
  else switchView("genes");
}

boot().catch(err => {
  document.getElementById("loading").textContent =
    `Could not load data (${err.message}). Run the pipeline first: python3 pipeline/run_all.py`;
});
