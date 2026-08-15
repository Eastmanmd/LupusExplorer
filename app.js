/* Lupus Gene Tracker — static dashboard over pipeline-generated JSON. */
"use strict";

const state = {
  genes: [],            // top N, full detail payload
  geneBySymbol: new Map(),
  pool: [],             // every ranked gene, slim: score components only
  ranked: [],           // pool re-scored under the live weights, best first
  weights: null,        // {mentions, recency, opentargets}, always summing to 1
  articles: new Map(),
  pathways: [],
  pathwayById: new Map(),
  meta: null,
  compare: [],          // symbols, max 3
  pathwaySource: "all",
  compareAsTable: false,
};

const WEIGHT_KEYS = ["mentions", "recency", "opentargets"];
const WEIGHT_LABELS = {
  mentions: "Mentions",
  recency: "Recency",
  opentargets: "Open Targets",
};
const WEIGHT_HELP = {
  mentions: "Total lupus papers mentioning the gene (log-scaled) — favors established targets",
  recency: "Papers in the last 5 years (log-scaled) — surfaces newly emergent candidates",
  opentargets: "Curated Open Targets association score for SLE — independent evidence",
};

const SOURCE_LABELS = { "GO:BP": "GO Biological Process", KEGG: "KEGG", REAC: "Reactome" };
/* Open Targets evidence datatypes shown in the heat strip, in fixed order */
const EVIDENCE_TYPES = [
  ["genetic_association", "Genetic", "Variant-level genetic association (GWAS credible sets, gene burden, ClinVar, UniProt variants)"],
  ["genetic_literature", "Curated genetics", "Curated clinical-genetics literature (Genomics England PanelApp, ClinGen, Orphanet, UniProt)"],
  ["rna_expression", "RNA", "Differential RNA expression in SLE (Expression Atlas)"],
  ["clinical", "Drug", "Clinical precedence — a drug against this target reached the clinic for SLE"],
  ["animal_model", "Model", "Mouse-model phenotypes mirroring SLE (IMPC)"],
];
const EXTRA_EVIDENCE_TYPES = [
  ["literature", "Text mining", "Europe PMC literature text mining (overlaps this site's own mention counts)"],
  ["somatic_mutation", "Somatic", "Somatic mutation evidence"],
];
const DATASOURCE_LABELS = {
  gwas_credible_sets: "GWAS credible sets", gene_burden: "Gene burden (rare variants)",
  eva: "ClinVar (EVA)", uniprot_literature: "UniProt literature", uniprot_variants: "UniProt variants",
  genomics_england: "Genomics England PanelApp", clingen: "ClinGen", orphanet: "Orphanet",
  expression_atlas: "Expression Atlas", impc: "IMPC mouse models",
  clinical_precedence: "Clinical precedence (drugs)", europepmc: "Europe PMC text mining",
  eva_somatic: "ClinVar somatic",
};
/* Grouping verified empirically against the fetched data (genes with a single
   datasource pin their datatype) — matches Open Targets' 2026 taxonomy. */
const DATATYPE_DATASOURCES = {
  genetic_association: ["gwas_credible_sets", "gene_burden", "eva", "uniprot_variants"],
  genetic_literature: ["uniprot_literature", "genomics_england", "clingen", "orphanet"],
  rna_expression: ["expression_atlas"],
  clinical: ["clinical_precedence"],
  animal_model: ["impc"],
  literature: ["europepmc"],
  somatic_mutation: ["eva_somatic"],
};
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
const SPARK_START = 1990;   // full modern publication history, so a gene's peak
                            // era is visible rather than cropped out

function sparkline(gene, width = 118, height = 26) {
  const end = state.meta.max_year;
  const values = [];
  for (let y = SPARK_START; y <= end; y++) values.push(gene.year_counts[y] || 0);
  const max = Math.max(...values, 1);
  const peakIndex = values.indexOf(max);
  const px = i => 2 + (i * (width - 8)) / (values.length - 1);
  const py = v => height - 3 - (v * (height - 8)) / max;
  const d = values.map((v, i) => `${i ? "L" : "M"}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join("");
  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, width, height,
    role: "img",
    "aria-label": `Papers per year ${SPARK_START}–${end}, peak ${SPARK_START + peakIndex}: ${values.join(", ")}` });
  svg.append(
    svgEl("path", { d, fill: "none", stroke: "var(--muted)", "stroke-width": 1.5,
      "stroke-linejoin": "round", "stroke-linecap": "round" }),
    // peak marker shows *when* the gene was hottest — the historical/recent tell
    svgEl("circle", { cx: px(peakIndex), cy: py(max), r: 2.5, fill: "none",
      stroke: "var(--muted)", "stroke-width": 1.5 }),
    svgEl("circle", { cx: px(values.length - 1), cy: py(values.at(-1)), r: 2.5,
      fill: "var(--series-1)" }),
  );
  return svg;
}

/* Literature velocity: last 5 years vs the 5 before, as a labelled archetype. */
const TREND_LABEL = { surging: "surging", declining: "declining", steady: "steady" };
function trendTag(g) {
  const trend = g.trend || "steady";
  const velocity = g.velocity;
  const tag = el("span", { class: `trend-tag trend-${trend}` },
    trend === "surging" ? "▲ surging" : trend === "declining" ? "▼ declining" : "steady");
  tag.addEventListener("pointermove", ev =>
    showTooltip(ev.clientX, ev.clientY,
      `Literature velocity — ${TREND_LABEL[trend]}`, [
        { value: `${velocity}×`, label: "last 5 yrs vs the 5 before" },
        ...(g.peak_year ? [{ value: String(g.peak_year), label: "peak year" }] : []),
      ]));
  tag.addEventListener("pointerleave", hideTooltip);
  return tag;
}

/* Most advanced clinical stage of any SLE drug against this target. */
const STAGE_BADGE = {
  APPROVAL: ["Approved", "stage-approved"],
  PHASE_3: ["Phase 3", "stage-3"],
  PHASE_2_3: ["Phase 2/3", "stage-3"],
  PHASE_2: ["Phase 2", "stage-2"],
  PHASE_1_2: ["Phase 1/2", "stage-2"],
  PHASE_1: ["Phase 1", "stage-1"],
  PRECLINICAL: ["Preclinical", "stage-1"],
};
function drugBadge(g) {
  const stage = g.drug_stage;
  if (!stage) return null;
  const [label, cls] = STAGE_BADGE[stage] || [stage.toLowerCase(), "stage-1"];
  const badge = el("span", { class: `badge drug-badge ${cls}` }, label);
  const drugs = (g.drugs || []).slice(0, 4);
  if (drugs.length) {
    badge.addEventListener("pointermove", ev =>
      showTooltip(ev.clientX, ev.clientY, "SLE drugs against this target",
        drugs.map(d => ({
          value: d.drug,
          label: (STAGE_BADGE[d.stage] || [d.stage])[0] + (d.action ? ` · ${d.action}` : ""),
        }))));
    badge.addEventListener("pointerleave", hideTooltip);
  }
  return badge;
}

/* Evidence heat strip: one cell per Open Targets datatype, shaded by score. */
function heatClass(score) {
  if (score >= 0.66) return "h3";
  if (score >= 0.33) return "h2";
  if (score > 0) return "h1";
  return "";
}
function evidenceStrip(gene) {
  const strip = el("div", { class: "evidence-strip", role: "img",
    "aria-label": "Open Targets evidence: " + EVIDENCE_TYPES.map(([id, label]) =>
      `${label} ${(gene.ot_datatypes[id] || 0).toFixed(2)}`).join(", ") });
  for (const [id, label, description] of EVIDENCE_TYPES) {
    const score = gene.ot_datatypes[id] || 0;
    const cell = el("span", { class: `evidence-cell ${heatClass(score)}` });
    cell.addEventListener("pointermove", ev =>
      showTooltip(ev.clientX, ev.clientY, description,
        [{ value: score ? score.toFixed(2) : "—", label }]));
    cell.addEventListener("pointerleave", hideTooltip);
    strip.append(cell);
  }
  return strip;
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

/* ---------- scoring under live weights ---------- */
function normalizeWeights(raw) {
  const total = WEIGHT_KEYS.reduce((s, k) => s + Math.max(0, raw[k] || 0), 0);
  if (!total) return { ...state.meta.weights };   // all-zero is meaningless; fall back
  const out = {};
  for (const k of WEIGHT_KEYS) out[k] = Math.max(0, raw[k] || 0) / total;
  return out;
}

/* Rescore the whole pool, sort, and record each gene's movement against the
   default-weight ranking that shipped in the data. */
function rescore() {
  const w = state.weights;
  for (const g of state.pool) {
    g.score = Math.round(1000 * (w.mentions * g.m + w.recency * g.r
                                 + w.opentargets * g.o)) / 10;
  }
  state.ranked = [...state.pool].sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
  state.ranked.forEach((g, i) => {
    g.liveRank = i + 1;
    // g.rank is the default-weight rank, null for genes below the shipped top N
    g.delta = g.rank ? g.rank - g.liveRank : null;
    g.detail = state.geneBySymbol.get(g.symbol) || null;
  });
}

function weightsAreDefault() {
  return WEIGHT_KEYS.every(k => Math.abs(state.weights[k] - state.meta.weights[k]) < 0.005);
}

function readWeightsFromHash() {
  const raw = new URLSearchParams(location.hash.slice(1)).get("w");
  if (!raw) return null;
  const parts = raw.split(",").map(Number);
  if (parts.length !== 3 || parts.some(n => !isFinite(n) || n < 0)) return null;
  return normalizeWeights({ mentions: parts[0], recency: parts[1], opentargets: parts[2] });
}

/* Single writer for the URL hash, so a custom weighting survives navigation
   and a shared link restores both the gene and the weighting. */
function setHash({ gene } = {}) {
  const params = new URLSearchParams();
  if (gene) params.set("gene", gene);
  if (!weightsAreDefault()) {
    params.set("w", WEIGHT_KEYS.map(k => state.weights[k].toFixed(2)).join(","));
  }
  const hash = params.toString();
  history.replaceState(null, "", hash ? `#${hash}` : location.pathname + location.search);
}

/* ---------- KPI row ---------- */
function renderKPIs() {
  const m = state.meta;
  const topGene = state.ranked[0];
  const rising = state.genes.filter(g => g.rising).length;
  document.getElementById("kpi-row").replaceChildren(
    statTile("Lupus articles in corpus", fmt(m.corpus_articles), `PubMed query, through ${m.max_year}`),
    statTile("Genes ranked", fmt(m.genes_ranked), `top ${fmt(m.genes_shown)} with full detail`),
    statTile("Top gene", topGene.symbol,
      `score ${topGene.score.toFixed(1)} · ${fmt(topGene.papers)} papers` +
      (weightsAreDefault() ? "" : " · custom weights")),
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
const genesFilter = { q: "", surgingOnly: false, hasDrugOnly: false,
                      risingOnly: false, geneticOnly: false, rnaOnly: false };

/* Weight sliders. Raw slider positions are independent 0–100; the weights they
   produce are normalized to sum to 1 so scores stay on the documented 0–100
   scale no matter how the sliders are dragged. */
const sliderRaw = {};
let rescoreQueued = false;

function weightPanel() {
  for (const k of WEIGHT_KEYS) sliderRaw[k] = Math.round(state.weights[k] * 100);
  const rows = WEIGHT_KEYS.map(k => {
    const input = el("input", { type: "range", min: "0", max: "100", step: "1",
      value: String(sliderRaw[k]), "aria-label": `${WEIGHT_LABELS[k]} weight`,
      oninput: e => { sliderRaw[k] = Number(e.target.value); queueRescore(); } });
    return el("div", { class: "weight-row", title: WEIGHT_HELP[k] },
      el("label", { class: "weight-label" }, WEIGHT_LABELS[k]),
      input,
      el("span", { class: "weight-val", id: `wval-${k}` },
        `${Math.round(state.weights[k] * 100)}%`));
  });
  return el("div", { class: "card weight-card" },
    el("div", { class: "weight-head" },
      el("div", {},
        el("h2", {}, "Score weighting"),
        el("p", { class: "sub" },
          "Drag to re-rank all " + fmt(state.meta.genes_ranked) + " genes in real time. " +
          "Weights are normalized to sum to 100%, so scores stay comparable.")),
      el("div", { class: "weight-actions" },
        el("button", { class: "back-btn weight-reset", onclick: () => {
          state.weights = { ...state.meta.weights };
          rescore();
          renderKPIs();
          renderGenesView();
          setHash();
        } }, "Reset to default"),
        el("span", { class: "muted weight-status", id: "weight-status" },
          weightsAreDefault() ? "default weighting" : "custom weighting"))),
    el("div", { class: "weight-grid" }, ...rows));
}

function queueRescore() {
  if (rescoreQueued) return;
  rescoreQueued = true;
  requestAnimationFrame(() => {
    rescoreQueued = false;
    state.weights = normalizeWeights(sliderRaw);
    rescore();
    for (const k of WEIGHT_KEYS) {
      const cell = document.getElementById(`wval-${k}`);
      if (cell) cell.textContent = `${Math.round(state.weights[k] * 100)}%`;
    }
    const status = document.getElementById("weight-status");
    if (status) status.textContent = weightsAreDefault() ? "default weighting" : "custom weighting";
    renderKPIs();
    renderGeneTable();
    setHash();
  });
}

function renderGenesView() {
  const view = document.getElementById("view-genes");
  const search = el("input", { type: "search", placeholder: "Search gene symbol or name…",
    value: genesFilter.q, oninput: e => { genesFilter.q = e.target.value; renderGeneTable(); } });
  const check = (key, label) => {
    const box = el("input", { type: "checkbox",
      onchange: e => { genesFilter[key] = e.target.checked; renderGeneTable(); } });
    box.checked = genesFilter[key];
    return el("label", { class: "check" }, box, label);
  };
  view.replaceChildren(
    weightPanel(),
    el("div", { class: "filter-row" },
      search,
      check("surgingOnly", "Surging"),
      check("hasDrugOnly", "In the clinic"),
      check("risingOnly", "Rising"),
      check("geneticOnly", "Genetic"),
      check("rnaOnly", "RNA evidence"),
      el("span", { class: "count", id: "gene-count" })),
    el("div", { class: "card" },
      el("p", { class: "sub", style: "margin-bottom:8px" },
        "Evidence strip (left → right): " + EVIDENCE_TYPES.map(([, l]) => l).join(" · ") +
        " — darker = stronger Open Targets evidence; hover a cell for the score."),
      el("table", { class: "data" },
        el("thead", {}, el("tr", {},
          el("th", { class: "num" }, "#"),
          el("th", {}, "Gene"),
          el("th", {}, "Combined score"),
          el("th", { class: "num" }, "Papers"),
          el("th", { class: "num" }, "Last 5 yr"),
          el("th", {}, `Trend ${SPARK_START}–${state.meta.max_year}`),
          el("th", {}, "Evidence"))),
        el("tbody", { id: "gene-tbody" }))),
  );
  renderGeneTable();
}

function renderGeneTable() {
  const q = genesFilter.q.trim().toLowerCase();
  // Velocity and clinical stage ride on every pool record; the Open Targets
  // evidence flags exist only for genes with a full detail payload.
  const needsDetail = genesFilter.risingOnly || genesFilter.geneticOnly || genesFilter.rnaOnly;
  const matches = g => {
    if (q && !g.symbol.toLowerCase().includes(q) && !g.name.toLowerCase().includes(q)) return false;
    if (genesFilter.surgingOnly && g.trend !== "surging") return false;
    if (genesFilter.hasDrugOnly && !g.drug_stage) return false;
    if (!needsDetail) return true;
    const d = g.detail;
    if (!d) return false;
    return (!genesFilter.risingOnly || d.rising)
      && (!genesFilter.geneticOnly || d.ot_genetic >= 0.2)
      && (!genesFilter.rnaOnly || (d.ot_datatypes.rna_expression || 0) > 0);
  };
  const matched = state.ranked.filter(matches);
  const rows = matched.slice(0, 300);
  const total = matched.length;
  document.getElementById("gene-count").textContent =
    total > rows.length ? `showing top ${rows.length} of ${fmt(total)} genes` : `${fmt(total)} genes`;

  const tbody = document.getElementById("gene-tbody");
  if (!rows.length) {
    tbody.replaceChildren(el("tr", {}, el("td", { colspan: "7", class: "empty-state" },
      el("p", {}, "No genes match these filters."),
      el("button", { class: "back-btn", onclick: () => {
        genesFilter.q = "";
        for (const k of ["surgingOnly", "hasDrugOnly", "risingOnly", "geneticOnly", "rnaOnly"]) genesFilter[k] = false;
        renderGenesView();
      } }, "Clear filters"))));
    return;
  }

  const maxScore = state.ranked[0].score || 1;
  tbody.replaceChildren(...rows.map(g =>
    el("tr", { class: "gene-row", tabindex: "0", role: "button",
      onclick: () => showDetail(g.symbol),
      onkeydown: ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); showDetail(g.symbol); } } },
      el("td", { class: "num muted" }, String(g.liveRank)),
      el("td", {},
        el("div", { class: "gene-symbol" }, g.symbol, rankDelta(g)),
        el("div", { class: "gene-name" }, g.name)),
      el("td", {}, el("div", { class: "score-cell" },
        el("div", { class: "bar-track" },
          el("div", { class: "bar-fill", style: `width:${(g.score / maxScore) * 100}%` })),
        el("span", { class: "val" }, g.score.toFixed(1)))),
      el("td", { class: "num" }, fmt(g.papers)),
      el("td", { class: "num" }, fmt(g.recent_papers)),
      el("td", {}, el("div", { class: "trend-cell" },
        g.detail ? sparkline(g.detail) : el("span", { class: "muted spark-gap" }, "—"),
        trendTag(g.detail ? { ...g, peak_year: g.detail.peak_year } : g))),
      el("td", {}, el("div", { class: "evidence-cell-wrap" },
        g.detail ? evidenceStrip(g.detail) : null,
        drugBadge(g.detail ? { ...g, drugs: g.detail.drugs } : g),
        g.detail && g.detail.rising ? el("span", { class: "badge rising" }, "rising ↑") : null))),

  ));
}

/* Movement against the default weighting — the point of the sliders. */
function rankDelta(g) {
  if (weightsAreDefault()) return null;
  if (g.rank === null || g.rank === undefined) {
    return el("span", { class: "delta delta-new",
      title: "Outside the default top " + fmt(state.meta.genes_shown) }, "new");
  }
  if (!g.delta) return null;
  const up = g.delta > 0;
  return el("span", { class: `delta ${up ? "delta-up" : "delta-down"}`,
    title: `Default-weight rank #${g.rank}` },
    `${up ? "▲" : "▼"} ${Math.abs(g.delta)}`);
}

/* ---------- gene detail ---------- */
function showDetail(symbol) {
  const g = state.geneBySymbol.get(symbol);
  if (!g) return showPoolDetail(symbol);
  const live = state.ranked.find(p => p.symbol === symbol);
  setHash({ gene: symbol });
  const view = document.getElementById("view-detail");
  const w = state.weights;
  const fw = k => w[k].toFixed(2).replace(/0$/, "");
  const components = [
    { label: `Mentions (×${fw("mentions")})`, value: g.mention_norm, color: "var(--seq-450)" },
    { label: `Recency (×${fw("recency")})`, value: g.recency_norm, color: "var(--seq-250)" },
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
      statTile("Combined score", (live ? live.score : g.score).toFixed(1),
        live ? `rank #${live.liveRank} of ${fmt(state.meta.genes_ranked)}` +
          (weightsAreDefault() ? "" : " · custom weights") : `rank #${g.rank}`),
      statTile("Lupus papers", fmt(g.papers), `all years · peak ${g.peak_year || "—"}`),
      statTile("Velocity", `${g.velocity}×`,
        `${g.trend} · ${fmt(g.recent_papers)} vs ${fmt(g.prior_papers)} papers`),
      statTile("Open Targets", g.ot_score.toFixed(2), `genetic ${g.ot_genetic.toFixed(2)}`)),
    el("div", { class: "card" },
      el("h2", {}, "Score breakdown"),
      el("p", { class: "sub" }, "Each component is normalized 0–1; the combined score is the weighted sum × 100." +
        (weightsAreDefault() ? "" : " Weights below reflect your custom slider settings.")),
      ...components.map(c => el("div", { class: "breakdown-row" },
        el("span", {}, c.label),
        el("div", { class: "track" }, el("div", { class: "fill", style: `width:${c.value * 100}%;background:${c.color}` })),
        el("span", { class: "num" }, c.value.toFixed(2))))),
    evidenceCard(g),
    drugCard(g),
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

/* Genes ranked but outside the shipped top N carry score components only —
   enough for an honest compact page, without article or pathway payloads. */
function showPoolDetail(symbol) {
  const g = state.ranked.find(p => p.symbol === symbol);
  if (!g) return;
  setHash({ gene: symbol });
  const w = state.weights;
  const fw = k => w[k].toFixed(2).replace(/0$/, "");
  const components = [
    { label: `Mentions (×${fw("mentions")})`, value: g.m, color: "var(--seq-450)" },
    { label: `Recency (×${fw("recency")})`, value: g.r, color: "var(--seq-250)" },
    { label: `Open Targets (×${fw("opentargets")})`, value: g.o, color: "var(--seq-150)" },
  ];
  document.getElementById("view-detail").replaceChildren(
    el("button", { class: "back-btn", onclick: () => switchView("genes") }, "← Back to leaderboard"),
    el("div", { class: "detail-head" },
      el("h2", {}, g.symbol),
      el("span", { class: "muted" }, g.name),
      el("a", { href: `https://www.ncbi.nlm.nih.gov/gene/${g.entrez}`, target: "_blank", rel: "noopener" }, "NCBI Gene ↗")),
    el("div", { class: "kpi-row" },
      statTile("Combined score", g.score.toFixed(1), `rank #${g.liveRank} of ${fmt(state.meta.genes_ranked)}`),
      statTile("Lupus papers", fmt(g.papers), "all years"),
      statTile("Last 5 years", fmt(g.recent_papers), "papers since " + state.meta.recent_cutoff),
      statTile("Open Targets", g.o.toFixed(2), "association score")),
    el("div", { class: "card" },
      el("h2", {}, "Score breakdown"),
      el("p", { class: "sub" }, "Each component is normalized 0–1; the combined score is the weighted sum × 100."),
      ...components.map(c => el("div", { class: "breakdown-row" },
        el("span", {}, c.label),
        el("div", { class: "track" }, el("div", { class: "fill", style: `width:${c.value * 100}%;background:${c.color}` })),
        el("span", { class: "num" }, c.value.toFixed(2))))),
    el("div", { class: "card" },
      el("h2", {}, "Limited detail for this gene"),
      el("p", { class: "sub" },
        `${g.symbol} ranks outside the top ${fmt(state.meta.genes_shown)} under the default ` +
        "weighting, so per-year trends, pathway membership, and article lists were not " +
        "included in the published dataset. Its score components above are complete."),
      el("p", { class: "sub" },
        el("a", { href: `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(`(${g.symbol}) AND (lupus)`)}`,
          target: "_blank", rel: "noopener" }, `Search PubMed for ${g.symbol} and lupus ↗`))),
  );
  switchView("detail", { keepHash: true });
  window.scrollTo({ top: 0 });
}

/* Drugs and clinical candidates targeting this gene in SLE. */
function drugCard(g) {
  const drugs = g.drugs || [];
  if (!drugs.length) return null;
  return el("div", { class: "card" },
    el("h2", {}, "Drugs and clinical candidates"),
    el("p", { class: "sub" },
      `SLE drugs and trial candidates acting on ${g.symbol}, from Open Targets / ChEMBL. ` +
      "Stage is the most advanced reached for lupus specifically."),
    el("table", { class: "data" },
      el("thead", {}, el("tr", {},
        el("th", {}, "Drug"), el("th", {}, "Stage"),
        el("th", {}, "Action"), el("th", {}, "Type"))),
      el("tbody", {}, ...drugs.map(d => {
        const [label, cls] = STAGE_BADGE[d.stage] || [d.stage, "stage-1"];
        return el("tr", {},
          el("td", {}, el("a", {
            href: `https://platform.opentargets.org/search?q=${encodeURIComponent(d.drug)}`,
            target: "_blank", rel: "noopener" }, d.drug)),
          el("td", {}, el("span", { class: `badge drug-badge ${cls}` }, label)),
          el("td", { class: "muted" }, d.action || "—"),
          el("td", { class: "muted" }, (d.type || "").toLowerCase() || "—"));
      }))));
}

/* Evidence sources card: one bar per Open Targets datatype, with the
   contributing datasources named beneath. */
function evidenceCard(g) {
  const rows = [];
  for (const [id, label, description] of [...EVIDENCE_TYPES, ...EXTRA_EVIDENCE_TYPES]) {
    const score = g.ot_datatypes[id] || 0;
    if (!score && EXTRA_EVIDENCE_TYPES.some(([xid]) => xid === id)) continue;
    const sources = (DATATYPE_DATASOURCES[id] || [])
      .filter(s => (g.ot_datasources[s] || 0) > 0)
      .map(s => `${DATASOURCE_LABELS[s] || s} ${g.ot_datasources[s].toFixed(2)}`);
    rows.push(el("div", { class: "evidence-row", title: description },
      el("div", { class: "breakdown-row" },
        el("span", {}, label),
        el("div", { class: "track" },
          el("div", { class: "fill", style: `width:${score * 100}%;background:var(--seq-450)` })),
        el("span", { class: "num" }, score ? score.toFixed(2) : "—")),
      sources.length ? el("div", { class: "evidence-sources" }, sources.join(" · ")) : null));
  }
  const empty = !Object.values(g.ot_datatypes).some(v => v > 0);
  return el("div", { class: "card" },
    el("h2", {}, "Evidence sources"),
    el("p", { class: "sub" },
      "Open Targets association evidence for ", g.symbol,
      " in SLE, by evidence class. Sub-lines name the contributing databases."),
    empty ? el("p", { class: "muted" },
      "No Open Targets association evidence — this gene ranks on literature mentions alone.")
      : el("div", {}, ...rows));
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

/* ---------- about ---------- */
const BODY_CALLOUTS = [
  // [side, labelY, targetX, targetY, title, fact]
  ["left", 46, 351, 38, "Brain & nerves", "Headaches, brain fog; neuropsychiatric lupus in a subset"],
  ["left", 152, 343, 120, "Heart & lungs", "Pericarditis, pleuritis; raised cardiovascular risk"],
  ["left", 256, 341, 180, "Kidneys", "Lupus nephritis in up to ~50% — a major driver of severe disease"],
  ["right", 84, 371, 55, "Skin", "Butterfly (malar) rash, photosensitivity — ~2 in 3 have skin disease"],
  ["right", 192, 409, 205, "Blood", "Anemia, low white cells or platelets; clotting antibodies"],
  ["right", 300, 377, 302, "Joints", "Arthritis or joint pain in ~9 in 10, usually non-erosive"],
];

function bodyDiagram() {
  const W = 720, H = 440;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img",
    "aria-label": "Diagram of the human body showing organ systems lupus commonly affects: " +
      BODY_CALLOUTS.map(c => `${c[4]} — ${c[5]}`).join("; ") });
  // One continuous anatomical outline, front-facing, centered at x=360.
  // The right half is defined as cubic Bézier segments from the top of the
  // head to the crotch; the left half is generated by mirroring, so the
  // figure is perfectly symmetric.
  const half = [
    // [c1x,c1y, c2x,c2y, x,y]
    [371, 24, 380, 33, 380, 47],    // skull
    [380, 58, 374, 67, 367, 72],    // jaw to chin
    [366, 77, 366, 80, 368, 84],    // neck
    [378, 88, 392, 92, 400, 100],   // trapezius to shoulder
    [408, 107, 411, 116, 411, 127], // deltoid
    [412, 146, 413, 163, 414, 180], // upper arm (outer) to elbow
    [415, 200, 413, 218, 410, 234], // forearm (outer)
    [409, 243, 411, 248, 410, 254], // wrist
    [409, 263, 399, 264, 398, 254], // hand
    [397, 245, 397, 240, 396, 232], // wrist (inner)
    [394, 214, 392, 198, 392, 182], // forearm (inner), going up
    [392, 166, 391, 150, 389, 134], // upper arm (inner)
    [388, 128, 387, 124, 384, 120], // armpit
    [387, 130, 388, 142, 388, 154], // chest side
    [387, 168, 384, 178, 383, 190], // waist
    [385, 204, 390, 214, 391, 226], // hip
    [392, 246, 389, 264, 386, 282], // outer thigh
    [385, 294, 385, 300, 384, 308], // knee (outer)
    [385, 322, 383, 338, 380, 352], // calf (outer)
    [379, 360, 379, 364, 379, 368], // ankle
    [382, 374, 384, 378, 383, 382], // heel
    [376, 386, 366, 386, 362, 382], // foot
    [360, 377, 360, 371, 361, 366], // ankle (inner)
    [363, 352, 364, 338, 364, 324], // calf (inner), going up
    [364, 312, 365, 304, 365, 296], // knee (inner)
    [366, 280, 367, 262, 366, 248], // inner thigh
    [364, 244, 362, 242, 360, 242], // crotch
  ];
  const mx = x => 720 - x;
  let d = "M 360 24 ";
  for (const [c1x, c1y, c2x, c2y, x, y] of half) d += `C ${c1x} ${c1y} ${c2x} ${c2y} ${x} ${y} `;
  for (let i = half.length - 1; i >= 0; i--) {
    const [c1x, c1y, c2x, c2y] = half[i];
    const [px, py] = i > 0 ? [half[i - 1][4], half[i - 1][5]] : [360, 24];
    d += `C ${mx(c2x)} ${c2y} ${mx(c1x)} ${c1y} ${mx(px)} ${py} `;
  }
  svg.append(svgEl("path", { d: d + "Z", fill: "var(--grid)" }));
  // Organs and involvement markers
  svg.append(
    // brain with sulci
    svgEl("ellipse", { cx: 360, cy: 40, rx: 13, ry: 10, fill: "var(--organ-brain)" }),
    svgEl("path", { d: "M 350 40 Q 356 34 361 39", fill: "none",
      stroke: "var(--surface)", "stroke-width": 1.4, "stroke-linecap": "round" }),
    svgEl("path", { d: "M 357 46 Q 363 40 369 44", fill: "none",
      stroke: "var(--surface)", "stroke-width": 1.4, "stroke-linecap": "round" }),
    // malar (butterfly) rash across the cheeks
    svgEl("path", { d: "M 348 53 Q 353 50 357 54 Q 353 58 348 56 Z",
      fill: "var(--organ-brain)", opacity: 0.75 }),
    svgEl("path", { d: "M 372 53 Q 367 50 363 54 Q 367 58 372 56 Z",
      fill: "var(--organ-brain)", opacity: 0.75 }),
    // lungs
    svgEl("ellipse", { cx: 347, cy: 122, rx: 9, ry: 17, fill: "var(--organ-lung)",
      transform: "rotate(7 347 122)" }),
    svgEl("ellipse", { cx: 373, cy: 122, rx: 9, ry: 17, fill: "var(--organ-lung)",
      transform: "rotate(-7 373 122)" }),
    // heart, nestled between the lungs
    svgEl("path", { d: "M 353 130 A 9 9 0 1 1 371 130 C 371 140 366 146 362 150 " +
      "C 358 146 353 140 353 130 Z", fill: "var(--organ-heart)",
      stroke: "var(--surface)", "stroke-width": 1.5 }),
    // kidneys
    svgEl("ellipse", { cx: 344, cy: 182, rx: 6.5, ry: 10, fill: "var(--organ-kidney)",
      transform: "rotate(14 344 182)" }),
    svgEl("ellipse", { cx: 376, cy: 182, rx: 6.5, ry: 10, fill: "var(--organ-kidney)",
      transform: "rotate(-14 376 182)" }),
    // joints: elbows and knees
    ...[[316, 180], [404, 180], [346, 304], [374, 304]].map(([x, y]) =>
      svgEl("circle", { cx: x, cy: y, r: 4, fill: "var(--organ-joint)",
        stroke: "var(--surface)", "stroke-width": 1.5 })),
    // blood droplet on the right forearm
    svgEl("path", { d: "M 404 196 C 408 202 410 206 410 210 A 6 6 0 1 1 398 210 " +
      "C 398 206 400 202 404 196 Z", fill: "var(--organ-heart)",
      stroke: "var(--surface)", "stroke-width": 1.5 }),
  );
  for (const [side, labelY, dotX, dotY, title, fact] of BODY_CALLOUTS) {
    const labelX = side === "left" ? 232 : 488;
    const anchor = side === "left" ? "end" : "start";
    svg.append(
      svgEl("line", { class: "callout-line", x1: labelX + (side === "left" ? 8 : -8),
        y1: labelY - 4, x2: dotX, y2: dotY }),
      svgEl("circle", { cx: dotX, cy: dotY, r: 2.5, fill: "var(--ink-2)" }),
      svgEl("text", { class: "callout-title", x: labelX, y: labelY - 8, "text-anchor": anchor }, title),
    );
    // wrap the fact over up to two lines of ~34 chars
    const words = fact.split(" ");
    const lines = [""];
    for (const word of words) {
      if ((lines.at(-1) + " " + word).trim().length > 36) lines.push(word);
      else lines[lines.length - 1] = (lines.at(-1) + " " + word).trim();
    }
    lines.forEach((line, i) => svg.append(
      svgEl("text", { class: "callout-sub", x: labelX, y: labelY + 8 + i * 15,
        "text-anchor": anchor }, line)));
  }
  return el("div", { class: "chart-box" }, svg);
}

function donutChart(slices, centerLabel) {
  const W = 260, H = 220, cx = 110, cy = 104, r = 78, inner = 48;
  const total = slices.reduce((s, d) => s + d.value, 0);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img",
    "aria-label": slices.map(d => `${d.label}: ${d.value}`).join(", ") });
  let angle = -Math.PI / 2;
  for (const d of slices) {
    const sweep = (d.value / total) * 2 * Math.PI;
    const a0 = angle, a1 = angle + sweep;
    angle = a1;
    const large = sweep > Math.PI ? 1 : 0;
    const p = (a, rad) => `${cx + rad * Math.cos(a)},${cy + rad * Math.sin(a)}`;
    const path = svgEl("path", {
      d: `M${p(a0, r)} A${r},${r} 0 ${large} 1 ${p(a1, r)} L${p(a1, inner)} ` +
         `A${inner},${inner} 0 ${large} 0 ${p(a0, inner)} Z`,
      fill: d.color, stroke: "var(--surface)", "stroke-width": 2,
    });
    path.addEventListener("pointermove", ev =>
      showTooltip(ev.clientX, ev.clientY, d.label, [
        { value: fmt(d.value), label: `terms (${Math.round((d.value / total) * 100)}%)`, color: d.color }]));
    path.addEventListener("pointerleave", hideTooltip);
    svg.append(path);
  }
  svg.append(
    svgEl("text", { class: "donut-center", x: cx, y: cy - 2, "text-anchor": "middle" }, fmt(total)),
    svgEl("text", { class: "tick-label", x: cx, y: cy + 14, "text-anchor": "middle" }, centerLabel));
  return el("div", { class: "chart-box donut-box" },
    svg,
    el("div", { class: "legend legend-stack" }, ...slices.map(d =>
      el("span", {}, el("span", { class: "swatch", style: `background:${d.color}` }),
        `${d.label} (${fmt(d.value)})`))));
}

function renderAboutView() {
  const dyn = document.getElementById("about-dynamic");
  const evidenceCounts = EVIDENCE_TYPES.map(([id, label]) => ({
    label, count: state.genes.filter(g => (g.ot_datatypes[id] || 0) > 0).length,
  }));
  const maxEvidence = Math.max(...evidenceCounts.map(d => d.count), 1);
  const termCounts = ["GO:BP", "KEGG", "REAC"].map(s => ({
    label: SOURCE_LABELS[s], color: SOURCE_COLORS[s],
    value: state.pathways.filter(t => t.source === s).length,
  }));

  dyn.replaceChildren(
    el("div", { class: "card" },
      el("h2", {}, "What is lupus?"),
      el("p", {}, "Systemic lupus erythematosus (SLE) is a chronic autoimmune disease: the immune ",
        "system loses tolerance to the body's own DNA and nuclear proteins, forms autoantibodies, ",
        "and the resulting immune complexes and interferon-driven inflammation damage tissue ",
        "throughout the body. It runs a relapsing–remitting course of flares and remission, and its ",
        "severity ranges from manageable skin and joint disease to organ-threatening kidney, heart, ",
        "or brain involvement. There is no cure yet, but modern treatment has transformed outcomes — ",
        "and the genetics tracked on this site is where much of the next generation of therapies is coming from.")),
    el("div", { class: "kpi-row" },
      statTile("People affected worldwide", "≈3.4M", "adults and children, all regions"),
      statTile("Female : male ratio", "9 : 1", "most often women of childbearing age"),
      statTile("Typical age at onset", "15–44", "years old"),
      statTile("Develop kidney disease", "≈50%", "lupus nephritis, the most feared complication")),
    el("div", { class: "card" },
      el("h2", {}, "How lupus affects the body"),
      el("p", { class: "sub" }, "Common organ-system involvement; percentages are approximate lifetime figures from clinical cohorts."),
      bodyDiagram()),
    el("div", { class: "card" },
      el("h2", {}, "Where this site's data comes from"),
      el("p", { class: "sub" },
        `Everything on this site is computed from public sources: ${fmt(state.meta.corpus_articles)} ` +
        "PubMed articles matching the lupus query, PubTator 3 gene annotations over that corpus, " +
        "Open Targets association evidence, and g:Profiler pathway enrichment. Refreshed weekly."),
      el("h3", { class: "about-h3" }, "Lupus articles per year (the full corpus)"),
      yearColumnChart(state.meta.corpus_year_counts, { label: "Lupus articles per year" }),
      el("div", { class: "about-grid" },
        el("div", {},
          el("h3", { class: "about-h3" }, "Top-300 genes by Open Targets evidence class"),
          el("p", { class: "sub" }, "Genes usually carry several classes at once, so rows overlap by design."),
          ...evidenceCounts.map(d => el("div", { class: "breakdown-row" },
            el("span", {}, d.label),
            el("div", { class: "track" },
              el("div", { class: "fill", style: `width:${(d.count / maxEvidence) * 100}%;background:var(--series-1)` })),
            el("span", { class: "num" }, fmt(d.count))))),
        el("div", {},
          el("h3", { class: "about-h3" }, "Enriched pathway terms by database"),
          donutChart(termCounts, "terms")))),
  );
}

/* ---------- view switching ---------- */
function switchView(name, { keepHash } = {}) {
  for (const tab of document.querySelectorAll(".tab")) {
    const active = tab.dataset.view === name;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  }
  for (const v of ["genes", "pathways", "compare", "about", "detail"]) {
    document.getElementById(`view-${v}`).hidden = v !== name;
  }
  if (!keepHash) setHash();   // drops #gene= but preserves any custom weighting
  if (name === "genes") renderGenesView();
  if (name === "pathways") renderPathwaysView();
  if (name === "compare") renderCompareView();
  if (name === "about") renderAboutView();
}

/* ---------- boot ---------- */
async function boot() {
  const [genes, articles, pathways, meta, pool] = await Promise.all(
    ["genes", "articles", "pathways", "meta", "pool"].map(name =>
      fetch(`data/${name}.json`).then(r => {
        if (!r.ok) throw new Error(`${name}.json: HTTP ${r.status}`);
        return r.json();
      })));
  state.genes = genes.genes;
  state.meta = meta;
  state.pathways = pathways.pathways;
  state.pool = pool.pool;
  for (const g of state.genes) state.geneBySymbol.set(g.symbol, g);
  for (const a of articles.articles) state.articles.set(a.pmid, a);
  for (const t of state.pathways) state.pathwayById.set(t.id, t);

  state.weights = readWeightsFromHash() || { ...meta.weights };
  rescore();

  document.getElementById("loading").remove();
  document.getElementById("provenance").textContent =
    `Last updated ${meta.updated} · ${fmt(meta.corpus_articles)} articles · query: ${meta.query}`;
  renderKPIs();
  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => switchView(tab.dataset.view));
  }
  const hashGene = new URLSearchParams(location.hash.slice(1)).get("gene");
  if (hashGene && state.ranked.some(g => g.symbol === hashGene)) showDetail(hashGene);
  else switchView("genes");
}

boot().catch(err => {
  document.getElementById("loading").textContent =
    `Could not load data (${err.message}). Run the pipeline first: python3 pipeline/run_all.py`;
});
