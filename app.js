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
  compareRange: 20,     // years shown on the trend chart, or "all"
  compareMode: "count", // "count" = papers/year, "share" = % of that year's corpus
  targets: [],          // drug-target opportunity scores, one per ranked gene
  targetMeta: null,     // pillar + criterion definitions shipped with the data
  targetWeights: null,  // {evidence, tractability, safety, opportunity}
  targetRanked: [],     // targets re-scored under the live pillar weights
  emerging: [],         // genes whose lupus literature is improbably recent
  emergingMeta: null,   // baseline, splits and quadrant definitions
  network: null,        // co-mention graph: nodes with layout, edges, modules
  networkBySymbol: new Map(),
  apol1: null,          // APOL1 partner table + two-ring co-mention map
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
  UNKNOWN: ["Unspecified", "stage-1"],   // ChEMBL row with no stage recorded
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
  // The axis must reach the data. Stopping at `max` can leave the top tick
  // BELOW it — 68 with a step of 20 yields 0/20/40/60 — and anything above the
  // last tick is then plotted above the plot area, taking its end label out of
  // the viewBox with it. Always emit one tick at or past the maximum.
  for (let v = 0; ; v += chosen) {
    ticks.push(Math.round(v * 100) / 100);
    if (v >= max - 1e-9) break;
  }
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
/* Year range shared by the trend chart and its data table, so "Show data
   table" always describes exactly what is plotted.

   The window is FIXED by default rather than derived from the selected genes.
   Deriving it meant that adding one early-published gene (CRP, first lupus
   mention 1965) rewrote the axis for every series already on the plot and
   squeezed the recent decades into a corner — the shape of a line changed
   without its data changing. */
function compareYears(seriesList, range) {
  const end = state.meta.max_year;
  let start;
  if (range === "all") {
    const firsts = seriesList.flatMap(s => Object.keys(s.yearCounts).map(Number));
    start = Math.max(1950, Math.min(...(firsts.length ? firsts : [end]), end - 9));
  } else {
    start = end - range + 1;
  }
  const years = [];
  for (let y = start; y <= end; y++) years.push(y);
  return years;
}

/* The last calendar year that has actually finished. The year in progress is
   only partly published, so its counts are not comparable with the years
   before it and are drawn dashed rather than solid. */
function completeYear() {
  const end = state.meta.max_year;
  return Math.min(state.meta.complete_year ?? end, end);
}

/* Papers in a year, or that gene's share of all lupus papers published that
   year. The corpus tripled between 2000 and 2025, so on raw counts a flat
   line is a gene quietly losing ground; share mode takes that growth out. */
function compareValue(series, year, mode) {
  const n = series.yearCounts[year] || 0;
  if (mode !== "share") return n;
  const corpus = (state.meta.corpus_year_counts || {})[year] || 0;
  return corpus ? (n / corpus) * 100 : 0;
}

function compareValueLabel(v, mode) {
  if (mode !== "share") return fmt(v);
  return `${v < 1 ? v.toFixed(2) : v.toFixed(1)}%`;
}

function trendLineChart(seriesList, { mode = "count", range = 20 } = {}) {
  const years = compareYears(seriesList, range);
  const end = years.at(-1);
  const complete = completeYear();
  const hasPartial = end > complete && years.includes(complete);
  const W = 900, H = 280, padL = 46, padR = 84, padT = 12, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const valueOf = (s, y) => compareValue(s, y, mode);
  const maxV = Math.max(mode === "share" ? 0.01 : 1,
    ...seriesList.flatMap(s => years.map(y => valueOf(s, y))));
  const ticks = niceTicks(maxV);
  const yMax = ticks.at(-1);
  const px = i => padL + (years.length === 1 ? plotW / 2 : (i * plotW) / (years.length - 1));
  const xOf = y => px(y - years[0]);
  const py = v => padT + plotH - (v / yMax) * plotH;

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img",
    "aria-label": `${mode === "share" ? "Share of lupus papers" : "Papers"} per year, ` +
      `${years[0]} to ${end}, for ${seriesList.map(s => s.name).join(", ")}` });
  for (const t of ticks) {
    if (t > 0) svg.append(svgEl("line", { class: "gridline", x1: padL, x2: W - padR, y1: py(t), y2: py(t) }));
    svg.append(svgEl("text", { class: "tick-label", x: padL - 6, y: py(t) + 3.5, "text-anchor": "end" },
      mode === "share" ? `${t}%` : fmt(t)));
  }
  svg.append(svgEl("line", { class: "baseline-rule", x1: padL, x2: W - padR, y1: py(0), y2: py(0) }));
  const labelEvery = Math.ceil(years.length / 12);
  years.forEach((y, i) => {
    if (i % labelEvery === 0) {
      svg.append(svgEl("text", { class: "tick-label", x: px(i), y: H - 8, "text-anchor": "middle" }, y));
    }
  });
  // Shade the incomplete year so the dashed tail has an obvious cause.
  if (hasPartial) {
    svg.append(svgEl("rect", { class: "partial-band", x: xOf(complete), y: padT,
      width: Math.max(2, xOf(end) - xOf(complete)), height: plotH }));
    const nx = (xOf(complete) + xOf(end)) / 2;
    svg.append(svgEl("text", { class: "tick-label partial-note", x: nx, y: padT + plotH - 6,
      "text-anchor": "start",
      transform: `rotate(-90 ${nx} ${padT + plotH - 6})` }, `${end} partial`));
  }

  const solid = years.filter(y => y <= complete);
  const tail = years.filter(y => y >= complete);
  const pathFor = (s, ys) => ys.map((y, i) =>
    `${i ? "L" : "M"}${xOf(y).toFixed(1)},${py(valueOf(s, y)).toFixed(1)}`).join("");

  seriesList.forEach((s, si) => {
    const color = `var(${SERIES_VARS[si]})`;
    if (solid.length > 1) {
      svg.append(svgEl("path", { d: pathFor(s, solid), fill: "none", stroke: color,
        "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    }
    if (hasPartial && tail.length > 1) {
      svg.append(svgEl("path", { d: pathFor(s, tail), fill: "none", stroke: color,
        "stroke-width": 2, "stroke-dasharray": "3 4", opacity: 0.5, "stroke-linecap": "round" }));
    }
    // Marker and label sit on the last COMPLETE year — anchoring them to a
    // partial count made every gene look like it was falling off a cliff.
    const markX = xOf(hasPartial ? complete : end);
    const markY = py(valueOf(s, hasPartial ? complete : end));
    svg.append(svgEl("circle", { cx: markX, cy: markY, r: 4, fill: color,
      stroke: "var(--surface)", "stroke-width": 2 }));
    svg.append(svgEl("text", { class: "direct-label", x: W - padR + 9, y: markY + 4 }, s.name));
  });
  // De-collide end labels, then keep the whole stack inside the plot area.
  const labels = [...svg.querySelectorAll(".direct-label")]
    .sort((a, b) => +a.getAttribute("y") - +b.getAttribute("y"));
  for (let i = 1; i < labels.length; i++) {
    const prev = +labels[i - 1].getAttribute("y"), cur = +labels[i].getAttribute("y");
    if (cur - prev < 13) labels[i].setAttribute("y", prev + 13);
  }
  const overflow = labels.length ? +labels.at(-1).getAttribute("y") - (padT + plotH) : 0;
  if (overflow > 0) {
    for (const l of labels) l.setAttribute("y", +l.getAttribute("y") - overflow);
  }
  for (const l of labels) {
    l.setAttribute("y", Math.min(padT + plotH, Math.max(padT + 8, +l.getAttribute("y"))));
  }

  const crosshair = svgEl("line", { class: "crosshair", y1: padT, y2: padT + plotH, visibility: "hidden" });
  svg.append(crosshair);
  const dots = seriesList.map((s, si) => {
    const d = svgEl("circle", { class: "hover-dot", r: 3.5, visibility: "hidden",
      fill: `var(${SERIES_VARS[si]})`, stroke: "var(--surface)", "stroke-width": 1.5 });
    svg.append(d);
    return d;
  });
  const hit = svgEl("rect", { x: padL, y: padT, width: plotW, height: plotH + padB, fill: "transparent" });
  hit.addEventListener("pointermove", ev => {
    const rect = svg.getBoundingClientRect();
    const sx = ((ev.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(years.length - 1,
      Math.round(((sx - padL) / plotW) * (years.length - 1))));
    const year = years[i];
    crosshair.setAttribute("x1", px(i));
    crosshair.setAttribute("x2", px(i));
    crosshair.setAttribute("visibility", "visible");
    seriesList.forEach((s, si) => {
      dots[si].setAttribute("cx", px(i));
      dots[si].setAttribute("cy", py(valueOf(s, year)));
      dots[si].setAttribute("visibility", "visible");
    });
    showTooltip(ev.clientX, ev.clientY,
      year > complete ? `${year} (partial year)` : String(year),
      seriesList.map((s, si) => ({
        value: compareValueLabel(valueOf(s, year), mode),
        label: s.name, color: `var(${SERIES_VARS[si]})`,
      })));
  });
  hit.addEventListener("pointerleave", () => {
    crosshair.setAttribute("visibility", "hidden");
    for (const d of dots) d.setAttribute("visibility", "hidden");
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

function readTargetWeightsFromHash() {
  const raw = new URLSearchParams(location.hash.slice(1)).get("tw");
  if (!raw || !state.targetMeta) return null;
  const parts = raw.split(",").map(Number);
  if (parts.length !== 4 || parts.some(n => !isFinite(n) || n < 0)) return null;
  const seed = {};
  TARGET_PILLARS.forEach((k, i) => { seed[k] = parts[i]; });
  return normalizeTargetWeights(seed);
}

/* Single writer for the URL hash, so a custom weighting survives navigation
   and a shared link restores both the gene and the weighting. */
function setHash({ gene, target, emerging, network } = {}) {
  const params = new URLSearchParams();
  if (gene) params.set("gene", gene);
  if (target) params.set("target", target);
  if (emerging) params.set("emerging", emerging);
  if (network) params.set("network", network);
  if (!weightsAreDefault()) {
    params.set("w", WEIGHT_KEYS.map(k => state.weights[k].toFixed(2)).join(","));
  }
  if (!targetWeightsAreDefault()) {
    params.set("tw", TARGET_PILLARS.map(k => state.targetWeights[k].toFixed(2)).join(","));
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

  view.replaceChildren(...[
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
  ].filter(Boolean));
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
      const o = el("option", { value: s }, s === "all" ? "Top 10 per source" : SOURCE_LABELS[s]);
      if (s === state.pathwaySource) o.selected = true;
      return o;
    }));
  const legend = el("div", { class: "legend" },
    ...Object.entries(SOURCE_LABELS).map(([s, label]) =>
      el("span", {}, el("span", { class: "swatch", style: `background:${SOURCE_COLORS[s]}` }), label)));

  // "All sources" gives each method its own panel of 10 rather than one merged
  // list, because a single list is dominated by GO:BP — its broadest terms sit
  // ~100 orders of magnitude below KEGG's best, so KEGG and Reactome would be
  // squeezed off the bottom of a shared ranking and a shared bar scale alike.
  if (state.pathwaySource === "all") {
    const panels = sources.slice(1).map(src => {
      const shown = state.pathways
        .filter(t => t.source === src)
        .sort((a, b) => a.p_value - b.p_value)
        .slice(0, 10);
      if (!shown.length) return null;
      const maxLog = Math.max(...shown.map(t => -Math.log10(t.p_value)));
      return el("div", { class: "card" },
        el("div", { class: "pillar-head" },
          el("h2", {},
            el("span", { class: "swatch", style: `background:${SOURCE_COLORS[src]}` }),
            SOURCE_LABELS[src]),
          el("span", { class: "muted" }, `top 10 of ${state.pathways.filter(t => t.source === src).length}`)),
        ...shown.map(t => pathwayRow(t, maxLog)));
    }).filter(Boolean);

    view.replaceChildren(
      el("div", { class: "filter-row" }, select,
        el("span", { class: "count" }, `${panels.length} sources · 10 terms each`)),
      el("div", { class: "card" },
        el("h2", {}, "Enriched pathways in the top lupus genes"),
        el("p", { class: "sub" },
          "The ten most significant terms from each method, scored by g:Profiler over the " +
          "top-ranked genes. Bars are scaled within their own panel, so lengths compare " +
          "between terms from the same source — not across sources. Pick a single source " +
          "above to see its full list. Click a term to see its genes.")),
      ...panels);
    return;
  }

  const shown = state.pathways
    .filter(t => t.source === state.pathwaySource)
    .sort((a, b) => a.p_value - b.p_value)
    .slice(0, 40);
  const maxLog = Math.max(...shown.map(t => -Math.log10(t.p_value)));

  view.replaceChildren(
    el("div", { class: "filter-row" }, select,
      el("span", { class: "count" }, `${shown.length} terms`)),
    legend,
    el("div", { class: "card" },
      el("h2", {}, `Enriched ${SOURCE_LABELS[state.pathwaySource]} terms`),
      el("p", { class: "sub" }, "Bar length = \u2212log\u2081\u2080(adjusted p) from g:Profiler over the top-ranked genes. Click a term to see its genes."),
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

  const picker = (label, value, options, onpick) => el("select", { "aria-label": label,
      onchange: e => { onpick(e.target.value); renderCompareView(); } },
    ...options.map(([v, text]) => {
      const o = el("option", { value: v }, text);
      if (String(value) === v) o.selected = true;
      return o;
    }));
  const rangeSelect = picker("Year range", state.compareRange,
    [["10", "Last 10 years"], ["20", "Last 20 years"], ["30", "Last 30 years"], ["all", "All years"]],
    v => { state.compareRange = v === "all" ? "all" : Number(v); });
  const modeSelect = picker("Vertical axis", state.compareMode,
    [["count", "Papers per year"], ["share", "Share of lupus papers"]],
    v => { state.compareMode = v; });

  const opts = { mode: state.compareMode, range: state.compareRange };
  const seriesList = state.compare.map(sym => ({
    name: sym, yearCounts: state.geneBySymbol.get(sym).year_counts,
  }));

  const body = [];
  if (seriesList.length) {
    body.push(
      el("div", { class: "legend" }, ...state.compare.map((sym, i) =>
        el("span", {}, el("span", { class: "key", style: `border-top-color:var(${SERIES_VARS[i]})` }), sym))),
      trendLineChart(seriesList, opts),
      el("button", { class: "table-toggle",
        onclick: () => { state.compareAsTable = !state.compareAsTable; renderCompareView(); } },
        state.compareAsTable ? "Hide data table" : "Show data table"),
    );
    if (state.compareAsTable) body.push(compareTable(seriesList, opts));
  } else {
    body.push(el("p", { class: "muted" }, "Add genes above to compare their publication trends."));
  }

  const partial = state.meta.max_year > completeYear();
  view.replaceChildren(
    el("div", { class: "compare-picker" }, ...chips, input, datalist),
    el("div", { class: "card" },
      el("h2", {}, state.compareMode === "share"
        ? "Share of lupus papers per year" : "Lupus papers per year"),
      el("p", { class: "sub" },
        state.compareMode === "share"
          ? "Each gene as a percentage of all lupus papers published that year. The corpus " +
            "roughly tripled between 2000 and 2025, so on raw counts a flat line is a gene " +
            "losing ground — this view takes that growth out."
          : "Publication trend comparison across the lupus corpus (PubTator 3 gene mentions)."),
      el("div", { class: "filter-row" }, rangeSelect, modeSelect,
        partial
          ? el("span", { class: "count" },
              `${state.meta.max_year} is still in progress — drawn dashed, and excluded ` +
              "from the trend statistics")
          : null),
      ...body),
  );
}

function compareTable(seriesList, { mode = "count", range = 20 } = {}) {
  const years = [...compareYears(seriesList, range)].reverse();
  const complete = completeYear();
  const table = el("table", { class: "data" },
    el("thead", {}, el("tr", {},
      el("th", {}, "Year"),
      ...seriesList.map(s => el("th", { class: "num" }, s.name)))),
    el("tbody", {}, ...years.map(y => el("tr", {},
      el("td", { class: "muted num" }, y > complete ? `${y} *` : String(y)),
      ...seriesList.map(s => el("td", { class: "num" },
        compareValueLabel(compareValue(s, y, mode), mode)))))));
  return years[0] > complete
    ? el("div", {}, table,
        el("p", { class: "sub" }, `* ${years[0]} is still in progress, so its counts are ` +
          "not comparable with the full years above it."))
    : table;
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

/* ---------- target opportunity ---------- */
/* A deliberately different question from the leaderboard. The leaderboard ranks
   attention; this ranks whether someone should start a drug programme. Genes
   with an approved SLE drug score near zero on Opportunity by design — that
   target is answered, not available. */

const PILLAR_COLORS = {
  evidence: "var(--series-1)",
  tractability: "var(--series-3)",
  safety: "var(--series-2)",
  opportunity: "var(--organ-joint)",
};
const FLAG_LABELS = {
  repurposing: ["repurposing", "A drug already hits this target in another immune-mediated disease, and the SLE space is still open"],
  whitespace: ["whitespace", "Credible lupus evidence and a tractable protein, with no SLE drug or trial candidate against it"],
  safety: ["safety flag", "Weak safety profile — LoF-intolerant, essential, or carrying curated liabilities"],
  approved: ["approved in SLE", "A drug against this target is already approved for lupus"],
};
const TARGET_PILLARS = ["evidence", "tractability", "safety", "opportunity"];

const targetsFilter = { q: "", openOnly: false, repurposeOnly: false,
                        tractableOnly: false, hideSafety: false };
const targetSliderRaw = {};
let targetRescoreQueued = false;

function normalizeTargetWeights(raw) {
  const total = TARGET_PILLARS.reduce((s, k) => s + Math.max(0, raw[k] || 0), 0);
  if (!total) return { ...state.targetMeta.pillar_weights };
  const out = {};
  for (const k of TARGET_PILLARS) out[k] = Math.max(0, raw[k] || 0) / total;
  return out;
}

function targetWeightsAreDefault() {
  if (!state.targetMeta || !state.targetWeights) return true;
  return TARGET_PILLARS.every(k =>
    Math.abs(state.targetWeights[k] - state.targetMeta.pillar_weights[k]) < 0.005);
}

/* Recompute pillar scores from the shipped per-criterion scores, then combine
   under the live pillar weights. The evidence gate is multiplicative and is
   applied after the weighted sum: tractability cannot substitute for a missing
   disease link, whatever the sliders say. */
function rescoreTargets() {
  const meta = state.targetMeta;
  const w = state.targetWeights;
  const gate = meta.evidence_gate;
  for (const t of state.targets) {
    const pillars = {};
    for (const pillar of TARGET_PILLARS) {
      let sum = 0, totalW = 0;
      for (const c of meta.criteria) {
        if (c.pillar !== pillar) continue;
        sum += (t.s[c.id] || 0) * c.weight;
        totalW += c.weight;
      }
      pillars[pillar] = totalW ? sum / totalW : 0;
    }
    t.p = pillars;
    t.gate = Math.max(gate.floor,
      Math.min(1, gate.floor + (1 - gate.floor) * pillars.evidence / gate.full));
    t.tos = Math.round(1000 * t.gate
      * TARGET_PILLARS.reduce((s, k) => s + w[k] * pillars[k], 0)) / 10;
  }
  state.targetRanked = [...state.targets]
    .sort((a, b) => b.tos - a.tos || a.symbol.localeCompare(b.symbol));
  state.targetRanked.forEach((t, i) => {
    t.liveRank = i + 1;
    t.delta = t.rank ? t.rank - t.liveRank : null;
  });
}

function queueTargetRescore() {
  if (targetRescoreQueued) return;
  targetRescoreQueued = true;
  requestAnimationFrame(() => {
    targetRescoreQueued = false;
    state.targetWeights = normalizeTargetWeights(targetSliderRaw);
    rescoreTargets();
    for (const k of TARGET_PILLARS) {
      const cell = document.getElementById(`twval-${k}`);
      if (cell) cell.textContent = `${Math.round(state.targetWeights[k] * 100)}%`;
    }
    const status = document.getElementById("target-weight-status");
    if (status) status.textContent = targetWeightsAreDefault() ? "default weighting" : "custom weighting";
    renderTargetTable();
    setHash();
  });
}

function targetWeightPanel() {
  const meta = state.targetMeta;
  for (const k of TARGET_PILLARS) targetSliderRaw[k] = Math.round(state.targetWeights[k] * 100);
  const rows = meta.pillars.map(pillar => {
    const input = el("input", { type: "range", min: "0", max: "100", step: "1",
      value: String(targetSliderRaw[pillar.id]),
      "aria-label": `${pillar.label} weight`,
      oninput: e => { targetSliderRaw[pillar.id] = Number(e.target.value); queueTargetRescore(); } });
    return el("div", { class: "tw-row" },
      el("div", { class: "tw-row-head" },
        el("span", { class: "weight-label" }, pillar.label),
        el("span", { class: "weight-val", id: `twval-${pillar.id}` },
          `${Math.round(state.targetWeights[pillar.id] * 100)}%`)),
      input,
      el("p", { class: "tw-help" }, pillar.help));
  });
  return el("div", { class: "card weight-card" },
    el("div", { class: "weight-card-head" },
      el("div", {},
        el("h2", {}, "What kind of target are you looking for?"),
        el("p", { class: "sub" },
          "Four pillars, re-weighted live across all " + fmt(state.targets.length) +
          " ranked genes. Push Opportunity up to hunt unclaimed space, Tractability " +
          "up to stay near proteins that can actually be drugged, Safety up to avoid " +
          "the ones you would regret.")),
      el("div", { class: "weight-actions" },
        el("button", { class: "back-btn", onclick: () => {
          state.targetWeights = { ...state.targetMeta.pillar_weights };
          rescoreTargets();
          renderTargetsView();
          setHash();
        } }, "Reset to default"),
        el("span", { class: "muted weight-status", id: "target-weight-status" },
          targetWeightsAreDefault() ? "default weighting" : "custom weighting"))),
    el("div", { class: "weight-grid" }, ...rows));
}

/* Four-cell strip, one per pillar, shaded by score — the compact form of the
   full breakdown on the detail page. */
function pillarStrip(t) {
  const meta = state.targetMeta;
  const strip = el("div", { class: "pillar-strip", role: "img",
    "aria-label": TARGET_PILLARS.map(k => `${k} ${t.p[k].toFixed(2)}`).join(", ") });
  for (const pillar of meta.pillars) {
    const score = t.p[pillar.id];
    const cell = el("span", { class: "pillar-cell" },
      el("span", { class: "pillar-fill",
        style: `height:${Math.max(6, score * 100)}%;background:${PILLAR_COLORS[pillar.id]}` }));
    cell.addEventListener("pointermove", ev =>
      showTooltip(ev.clientX, ev.clientY, pillar.label,
        [{ value: score.toFixed(2), label: pillar.help, color: PILLAR_COLORS[pillar.id] }]));
    cell.addEventListener("pointerleave", hideTooltip);
    strip.append(cell);
  }
  return strip;
}

function flagBadges(t) {
  return t.flags.map(f => {
    const [label, help] = FLAG_LABELS[f] || [f, ""];
    const badge = el("span", { class: `badge flag flag-${f}` }, label);
    if (help) {
      badge.addEventListener("pointermove", ev =>
        showTooltip(ev.clientX, ev.clientY, label, [{ value: "", label: help }]));
      badge.addEventListener("pointerleave", hideTooltip);
    }
    return badge;
  });
}

function renderTargetsView() {
  const view = document.getElementById("view-targets");
  const search = el("input", { type: "search", placeholder: "Search gene symbol or name…",
    value: targetsFilter.q,
    oninput: e => { targetsFilter.q = e.target.value; renderTargetTable(); } });
  const check = (key, label, title) => {
    const box = el("input", { type: "checkbox",
      onchange: e => { targetsFilter[key] = e.target.checked; renderTargetTable(); } });
    box.checked = targetsFilter[key];
    return el("label", { class: "check", title }, box, label);
  };
  view.replaceChildren(
    el("div", { class: "card intro-card" },
      el("h2", {}, "Target Opportunity Score"),
      el("p", {},
        "The leaderboard ranks how much the field is talking about a gene. That is a " +
        "popularity measure, and the genes at the top are largely the ones already " +
        "drugged. This tab scores a different question: ",
        el("strong", {}, "should someone start a drug programme here?")),
      el("p", { class: "sub" },
        "Every gene is scored on four pillars — Evidence, Tractability, Safety and " +
        "Opportunity — built from " + state.targetMeta.criteria.length +
        " named criteria drawn from Open Targets, gnomAD, DepMap, IMPC, IntAct, ChEMBL " +
        "and PubMed. Opportunity runs backwards to the leaderboard on purpose: a target " +
        "with an approved lupus drug scores near zero, because it is no longer an " +
        "opportunity. Click any gene for the full criterion-by-criterion breakdown."),
      el("p", { class: "sub" },
        "Evidence also acts as a gate, not just a weight — a beautifully druggable " +
        "protein with no credible link to lupus is not a lupus target, so the whole " +
        "score is scaled down when the evidence pillar is weak.")),
    targetWeightPanel(),
    el("div", { class: "filter-row" },
      search,
      check("openOnly", "No SLE programme", "Genes with no drug or trial candidate against them in lupus"),
      check("repurposeOnly", "Repurposing candidates", "A drug already hits this target in another immune-mediated disease"),
      check("tractableOnly", "Tractable", "Tractability pillar at 0.50 or above"),
      check("hideSafety", "Hide safety flags", "Drop genes whose safety pillar is below 0.35"),
      el("span", { class: "count", id: "target-count" })),
    el("div", { class: "card" },
      el("p", { class: "sub", style: "margin-bottom:8px" },
        "Pillar strip (left → right): " +
        state.targetMeta.pillars.map(p => p.label).join(" · ") +
        " — taller = stronger; hover a cell for the score."),
      el("table", { class: "data" },
        el("thead", {}, el("tr", {},
          el("th", { class: "num" }, "#"),
          el("th", {}, "Gene"),
          el("th", {}, "Opportunity score"),
          el("th", {}, "Pillars"),
          el("th", {}, "SLE stage"),
          el("th", {}, "Elsewhere"),
          el("th", { class: "num" }, "Lit #"))),
        el("tbody", { id: "target-tbody" }))),
  );
  renderTargetTable();
}

function renderTargetTable() {
  const q = targetsFilter.q.trim().toLowerCase();
  const matches = t => {
    if (q && !t.symbol.toLowerCase().includes(q) && !t.name.toLowerCase().includes(q)) return false;
    if (targetsFilter.openOnly && t.sle_stage) return false;
    if (targetsFilter.repurposeOnly && !(t.cross_drugs || []).length) return false;
    if (targetsFilter.tractableOnly && t.p.tractability < 0.5) return false;
    if (targetsFilter.hideSafety && t.p.safety < 0.35) return false;
    return true;
  };
  const rows = state.targetRanked.filter(matches);
  document.getElementById("target-count").textContent =
    `${fmt(rows.length)} of ${fmt(state.targets.length)} genes`;

  const tbody = document.getElementById("target-tbody");
  if (!rows.length) {
    tbody.replaceChildren(el("tr", {}, el("td", { colspan: "7", class: "empty-state" },
      el("p", {}, "No genes match these filters."),
      el("button", { class: "back-btn", onclick: () => {
        targetsFilter.q = "";
        for (const k of ["openOnly", "repurposeOnly", "tractableOnly", "hideSafety"]) targetsFilter[k] = false;
        renderTargetsView();
      } }, "Clear filters"))));
    return;
  }

  const maxScore = state.targetRanked[0].tos || 1;
  tbody.replaceChildren(...rows.map(t => {
    const best = (t.cross_drugs || [])[0];
    return el("tr", { class: "gene-row", tabindex: "0", role: "button",
      onclick: () => showTargetDetail(t.symbol),
      onkeydown: ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); showTargetDetail(t.symbol); } } },
      el("td", { class: "num muted" }, String(t.liveRank)),
      el("td", {},
        el("div", { class: "gene-symbol" }, t.symbol, targetRankDelta(t)),
        el("div", { class: "gene-name" }, t.name),
        t.flags.length ? el("div", { class: "flag-row" }, ...flagBadges(t)) : null),
      el("td", {}, el("div", { class: "score-cell" },
        el("div", { class: "bar-track" },
          el("div", { class: "bar-fill", style: `width:${(t.tos / maxScore) * 100}%` })),
        el("span", { class: "val" }, t.tos.toFixed(1)))),
      el("td", {}, pillarStrip(t)),
      el("td", {}, t.sle_stage
        ? drugBadge({ drug_stage: t.sle_stage, drugs: t.sle_drugs })
        : el("span", { class: "muted" }, "open")),
      el("td", {}, best
        ? el("span", { class: "muted xind",
            title: `${best.drug} — ${(STAGE_BADGE[best.stage] || [best.stage])[0]} in ${best.disease}` },
            `${(STAGE_BADGE[best.stage] || [best.stage])[0]} · ${best.disease}`)
        : el("span", { class: "muted" }, "—")),
      el("td", { class: "num muted" }, `#${t.lit_rank}`));
  }));
}

function targetRankDelta(t) {
  if (targetWeightsAreDefault() || !t.delta) return null;
  const up = t.delta > 0;
  return el("span", { class: `delta ${up ? "delta-up" : "delta-down"}`,
    title: `Default-weight rank #${t.rank}` },
    `${up ? "▲" : "▼"} ${Math.abs(t.delta)}`);
}

/* ---------- target detail ---------- */
function criterionRow(t, c) {
  const score = t.s[c.id] || 0;
  const contribution = score * c.weight;
  return el("div", { class: "criterion" },
    el("div", { class: "breakdown-row" },
      el("span", { class: "criterion-label" }, c.label,
        el("span", { class: "criterion-weight" }, `×${c.weight.toFixed(2)}`)),
      el("div", { class: "track" },
        el("div", { class: "fill",
          style: `width:${score * 100}%;background:${PILLAR_COLORS[c.pillar]}` })),
      el("span", { class: "num" }, score.toFixed(2))),
    el("div", { class: "criterion-detail" }, t.d[c.id] || "—"),
    el("div", { class: "criterion-meta" },
      el("span", {}, c.help),
      el("span", { class: "criterion-source" }, c.source)));
}

function pillarCard(t, pillar) {
  const meta = state.targetMeta;
  const criteria = meta.criteria.filter(c => c.pillar === pillar.id);
  const score = t.p[pillar.id];
  const weight = state.targetWeights[pillar.id];
  return el("div", { class: "card pillar-card" },
    el("div", { class: "pillar-head" },
      el("h2", {}, pillar.label),
      el("div", { class: "pillar-score" },
        el("span", { class: "pillar-value", style: `color:${PILLAR_COLORS[pillar.id]}` },
          score.toFixed(2)),
        el("span", { class: "muted" }, `× ${Math.round(weight * 100)}% weight`))),
    el("p", { class: "sub" }, pillar.help),
    el("div", { class: "pillar-bar" },
      el("div", { class: "fill",
        style: `width:${score * 100}%;background:${PILLAR_COLORS[pillar.id]}` })),
    ...criteria.map(c => criterionRow(t, c)));
}

function crossDrugCard(t) {
  const drugs = t.cross_drugs || [];
  if (!drugs.length) return null;
  return el("div", { class: "card" },
    el("h2", {}, "Drugs against this target in other immune-mediated diseases"),
    el("p", { class: "sub" },
      "Proven human pharmacology one indication away from lupus. Sourced from Open " +
      "Targets / ChEMBL across " + state.targetMeta.cross_indications.length +
      " curated immune-mediated indications; lupus itself is excluded."),
    el("table", { class: "data" },
      el("thead", {}, el("tr", {},
        el("th", {}, "Drug"), el("th", {}, "Stage"), el("th", {}, "Indication"),
        el("th", {}, "Action"), el("th", {}, "Type"))),
      el("tbody", {}, ...drugs.map(d => {
        const [label, cls] = STAGE_BADGE[d.stage] || [d.stage, "stage-1"];
        return el("tr", {},
          el("td", {}, el("a", {
            href: `https://platform.opentargets.org/search?q=${encodeURIComponent(d.drug)}`,
            target: "_blank", rel: "noopener" }, d.drug)),
          el("td", {}, el("span", { class: `badge drug-badge ${cls}` }, label)),
          el("td", {}, d.disease),
          el("td", { class: "muted" }, d.action || "—"),
          el("td", { class: "muted" }, (d.type || "").toLowerCase() || "—"));
      }))));
}

function showTargetDetail(symbol) {
  const t = state.targetRanked.find(x => x.symbol === symbol);
  if (!t) return;
  setHash({ target: symbol });
  const meta = state.targetMeta;
  const best = (t.cross_drugs || [])[0];
  const view = document.getElementById("view-detail");
  const leaderboardGene = state.geneBySymbol.get(symbol);

  // replaceChildren stringifies non-nodes, so a `null` branch renders the word
  // "null" — unlike el(), which drops them.
  view.replaceChildren(...[
    el("button", { class: "back-btn", onclick: () => switchView("targets") },
      "← Back to target opportunities"),
    el("div", { class: "detail-head" },
      el("h2", {}, t.symbol),
      el("span", { class: "muted" }, t.name),
      ...flagBadges(t),
      el("a", { href: `https://platform.opentargets.org/target/${symbol}`,
        target: "_blank", rel: "noopener" }, "Open Targets ↗"),
      el("a", { href: `https://www.ncbi.nlm.nih.gov/gene/${t.entrez}`,
        target: "_blank", rel: "noopener" }, "NCBI Gene ↗")),
    el("div", { class: "kpi-row" },
      statTile("Opportunity score", t.tos.toFixed(1),
        `rank #${t.liveRank} of ${fmt(state.targets.length)}` +
        (targetWeightsAreDefault() ? "" : " · custom weights")),
      statTile("SLE programme", t.sle_stage
        ? (STAGE_BADGE[t.sle_stage] || [t.sle_stage])[0] : "none",
        t.sle_stage ? (t.sle_drugs || []).slice(0, 2).map(d => d.drug).join(", ")
                    : "the space is open"),
      statTile("Elsewhere", best ? (STAGE_BADGE[best.stage] || [best.stage])[0] : "—",
        best ? `${best.drug} · ${best.disease}` : "no immune-mediated precedent"),
      statTile("Literature rank", `#${t.lit_rank}`,
        `${fmt(t.papers)} lupus papers · ${t.trend}`)),
    el("div", { class: "card" },
      el("h2", {}, "How the score is built"),
      el("p", { class: "sub" },
        "Each criterion is normalized 0–1 and combined within its pillar; the pillars " +
        "are then combined under the weights you set. Every number below names the " +
        "database it came from."),
      el("div", { class: "pillar-summary" },
        ...meta.pillars.map(p => el("div", { class: "pillar-summary-row" },
          el("span", { class: "criterion-label" }, p.label,
            el("span", { class: "criterion-weight" },
              `×${state.targetWeights[p.id].toFixed(2)}`)),
          el("div", { class: "track" },
            el("div", { class: "fill",
              style: `width:${t.p[p.id] * 100}%;background:${PILLAR_COLORS[p.id]}` })),
          el("span", { class: "num" }, t.p[p.id].toFixed(2))))),
      t.gate < 0.999
        ? el("p", { class: "gate-note" },
            `Evidence gate: the weighted total is scaled to ${Math.round(t.gate * 100)}% ` +
            `because the evidence pillar (${t.p.evidence.toFixed(2)}) sits below ` +
            `${meta.evidence_gate.full}. Druggability cannot substitute for a missing ` +
            "link to lupus.")
        : el("p", { class: "gate-note gate-clear" },
            "Evidence gate: no penalty — the lupus link is strong enough to take the " +
            "score at face value.")),
    ...meta.pillars.map(p => pillarCard(t, p)),
    crossDrugCard(t),
    drugCard({ symbol: t.symbol, drugs: t.sle_drugs }),
    el("div", { class: "card" },
      el("h2", {}, "Protein context"),
      el("div", { class: "context-grid" },
        el("div", {},
          el("div", { class: "label" }, "Protein class"),
          el("div", {}, t.classes.length ? t.classes.join(" · ") : "not assigned")),
        el("div", {},
          el("div", { class: "label" }, "Subcellular location"),
          el("div", {}, t.locations.length ? t.locations.join(" · ") : "not annotated")),
        el("div", {},
          el("div", { class: "label" }, "Validated interaction partners"),
          el("div", {}, t.partners.length
            ? t.partners.join(", ")
            : "none among targets with an SLE programme at Phase 2+")))),
    leaderboardGene
      ? el("div", { class: "card" },
          el("h2", {}, "Literature view"),
          el("p", { class: "sub" },
            `${t.symbol} ranks #${t.lit_rank} on the literature leaderboard with ` +
            `${fmt(t.papers)} lupus papers.`),
          el("button", { class: "back-btn", onclick: () => showDetail(symbol) },
            `Open the full literature page for ${t.symbol} →`))
      : null,
  ].filter(Boolean));
  switchView("detail", { keepHash: true });
  window.scrollTo({ top: 0 });
}

/* ---------- emerging genes ---------- */
/* The leaderboard answers "what is the field talking about". This answers
   "what has the field only just started talking about" — a question its score
   cannot express, because two of its three terms grow with accumulated
   attention. See pipeline/build_emerging.py for the statistics. */
const QUADRANT_COLORS = {
  borrowed: "var(--series-2)",
  frontier: "var(--series-3)",
  accelerating: "var(--series-1)",
  climbers: "var(--series-4)",
};
const SUPERSCRIPTS = "\u2070\u00b9\u00b2\u00b3\u2074\u2075\u2076\u2077\u2078\u2079";
function supers(n) {
  return String(n).replace(/\d/g, d => SUPERSCRIPTS[+d]);
}
const emergingFilter = { q: "", quadrant: "all", newOnly: false,
                         hideUnverified: false, openOnly: false };

function emergingRows() {
  const q = emergingFilter.q.trim().toLowerCase();
  const cutoff = state.emergingMeta.recent_cutoff;
  return state.emerging.filter(g => {
    if (q && !g.symbol.toLowerCase().includes(q) && !g.name.toLowerCase().includes(q)) return false;
    if (emergingFilter.quadrant !== "all" && g.quadrant !== emergingFilter.quadrant) return false;
    if (emergingFilter.newOnly && g.debut < cutoff) return false;
    if (emergingFilter.hideUnverified && g.unverified) return false;
    if (emergingFilter.openOnly && g.drug_stage) return false;
    return true;
  });
}

/* Corroboration: an independent PubMed keyword search for the same gene inside
   the same lupus corpus. PubTator resolves synonyms, so a gene whose alias is
   also a trending acronym silently inherits that acronym's papers — in a
   literature this small one collision is enough to invent a top-ranked gene.
   When the two counts disagree badly, say so rather than hiding it. */
function corroborationNote(g) {
  if (g.corroboration == null) return null;
  const [lo, hi] = state.emergingMeta.corroboration_range;
  const badge = el("span", { class: `badge ${g.unverified ? "unverified" : "verified"}` },
    g.unverified ? "check mentions" : `${g.corroboration}× corroborated`);
  badge.addEventListener("pointermove", ev =>
    showTooltip(ev.clientX, ev.clientY, "PubTator mentions vs a keyword search", [
      { value: fmt(g.papers), label: "PubTator gene mentions in the corpus" },
      { value: fmt(g.pubmed_lupus), label: "papers matching the gene's own name or aliases" },
      { value: `${g.corroboration}×`, label: `ratio — expected between ${lo} and ${hi}` },
      ...(g.aliases || []).length
        ? [{ value: g.aliases.slice(0, 5).join(", "), label: "aliases searched" }] : [],
    ]));
  badge.addEventListener("pointerleave", hideTooltip);
  return badge;
}

/* Scatter of the two axes, split into the four quadrants. X is a log axis
   because PubMed footprints span five orders of magnitude; a linear one would
   pile every gene against the left edge. */
function quadrantChart(rows) {
  const m = state.emergingMeta;
  const pts = rows.filter(g => g.pubmed_total > 0);
  if (!pts.length) {
    return el("p", { class: "muted" }, "No genes match these filters.");
  }
  const W = 900, H = 460, padL = 52, padR = 18, padT = 20, padB = 46;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const totals = pts.map(g => g.pubmed_total);
  const lo = Math.max(1, Math.floor(Math.log10(Math.min(...totals))));
  const hi = Math.max(lo + 1, Math.ceil(Math.log10(Math.max(...totals))));
  const px = t => padL + ((Math.log10(t) - lo) / (hi - lo)) * plotW;
  // The y axis starts just under the lowest gene, not at zero and not at the
  // corpus baseline: every gene here clears that baseline by construction, so
  // anchoring to it would spend a fifth of the plot on an empty band.
  const yLo = Math.max(0, Math.floor(Math.min(...pts.map(g => g.recent_share)) * 10) / 10 - 0.02);
  // Headroom above 100%: without it the many genes at exactly 100% sit on the
  // top edge, half-clipped and overlapping the quadrant captions.
  const yHi = 1 + 0.09 * (1 - yLo);
  const py = s => padT + plotH - ((s - yLo) / (yHi - yLo)) * plotH;
  const maxE = Math.max(...pts.map(g => g.emergence));
  const rOf = g => 3 + 5 * Math.sqrt(g.emergence / maxE);

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img",
    "aria-label": `${pts.length} emerging genes plotted by total PubMed footprint ` +
      `(horizontal) against the share of their lupus papers published since ` +
      `${m.recent_cutoff} (vertical)` });

  for (let d = lo; d <= hi; d++) {
    svg.append(svgEl("line", { class: "gridline", x1: px(10 ** d), x2: px(10 ** d), y1: padT, y2: padT + plotH }));
    svg.append(svgEl("text", { class: "tick-label", x: px(10 ** d), y: H - 26, "text-anchor": "middle" },
      d >= 6 ? `${10 ** (d - 6)}M` : d >= 3 ? `${10 ** (d - 3)}k` : String(10 ** d)));
  }
  for (let pct = Math.ceil(yLo * 10) * 10; pct <= 100; pct += 10) {
    const y = py(pct / 100);
    svg.append(svgEl("line", { class: "gridline", x1: padL, x2: W - padR, y1: y, y2: y }));
    svg.append(svgEl("text", { class: "tick-label", x: padL - 6, y: y + 3.5, "text-anchor": "end" },
      `${pct}%`));
  }
  svg.append(svgEl("text", { class: "axis-label", x: padL + plotW / 2, y: H - 8, "text-anchor": "middle" },
    "Total PubMed papers on this gene, all of biology →"));
  svg.append(svgEl("text", { class: "axis-label", "text-anchor": "middle",
    transform: `rotate(-90 12 ${padT + plotH / 2})`, x: 12, y: padT + plotH / 2 },
    `↑ Share of its lupus papers published since ${m.recent_cutoff}`));

  // The two splits, and the corpus baseline they sit above.
  const splitX = px(m.maturity_split), splitY = py(m.novelty_split);
  svg.append(svgEl("line", { class: "split-rule", x1: splitX, x2: splitX, y1: padT, y2: padT + plotH }));
  svg.append(svgEl("line", { class: "split-rule", x1: padL, x2: W - padR, y1: splitY, y2: splitY }));
  for (const q of m.quadrants) {
    const x = q.mature ? W - padR - 8 : padL + 8;
    const y = q.novel ? padT + 11 : padT + plotH - 8;
    svg.append(svgEl("text", { class: "quadrant-label", x, y,
      "text-anchor": q.mature ? "end" : "start", fill: QUADRANT_COLORS[q.id] }, q.label));
  }

  // Dots first, then labels, so no label is buried under a later dot.
  const placed = [];
  const byEmergence = [...pts].sort((a, b) => b.emergence - a.emergence);
  for (const g of byEmergence) {
    const cx = px(g.pubmed_total), cy = py(g.recent_share);
    const dot = svgEl("circle", { class: "scatter-dot", cx, cy, r: rOf(g),
      fill: QUADRANT_COLORS[g.quadrant] || "var(--muted)",
      opacity: g.unverified ? 0.35 : 0.75 });
    dot.addEventListener("pointermove", ev =>
      showTooltip(ev.clientX, ev.clientY, `${g.symbol} — ${g.name}`, [
        { value: `${Math.round(g.recent_share * 100)}%`,
          label: `of its ${g.papers} lupus papers are from ${m.recent_cutoff}–${m.complete_year}`,
          color: QUADRANT_COLORS[g.quadrant] },
        { value: fmt(g.pubmed_total), label: "papers on this gene in all of PubMed" },
        { value: g.emergence.toFixed(1), label: "emergence (0–100)" },
        { value: String(g.debut), label: "first lupus paper" },
      ]));
    dot.addEventListener("pointerleave", hideTooltip);
    dot.addEventListener("click", () => showEmergingDetail(g.symbol));
    svg.append(dot);
  }
  for (const g of byEmergence) {
    if (placed.length >= 14) break;
    const cx = px(g.pubmed_total), cy = py(g.recent_share);
    const lx = cx + rOf(g) + 4, ly = cy + 3.5;
    if (lx > W - padR - 30) continue;
    if (placed.some(p => Math.abs(p.x - lx) < 46 && Math.abs(p.y - ly) < 11)) continue;
    placed.push({ x: lx, y: ly });
    svg.append(svgEl("text", { class: "scatter-label", x: lx, y: ly }, g.symbol));
  }
  return el("div", { class: "chart-box" }, svg);
}

function renderEmergingView() {
  const view = document.getElementById("view-emerging");
  const m = state.emergingMeta;
  const search = el("input", { type: "search", placeholder: "Search gene symbol or name…",
    value: emergingFilter.q,
    oninput: e => { emergingFilter.q = e.target.value; renderEmergingBody(); } });
  const quadSelect = el("select", { "aria-label": "Quadrant",
    onchange: e => { emergingFilter.quadrant = e.target.value; renderEmergingBody(); } },
    ...[["all", "All four quadrants"], ...m.quadrants.map(q => [q.id, q.label])]
      .map(([v, text]) => {
        const o = el("option", { value: v }, text);
        if (emergingFilter.quadrant === v) o.selected = true;
        return o;
      }));
  const check = (key, label, title) => {
    const box = el("input", { type: "checkbox",
      onchange: e => { emergingFilter[key] = e.target.checked; renderEmergingBody(); } });
    box.checked = emergingFilter[key];
    return el("label", { class: "check", title }, box, label);
  };
  const brandNew = state.emerging.filter(g => g.debut >= m.recent_cutoff).length;
  const borrowed = state.emerging.filter(g => g.quadrant === "borrowed").length;

  view.replaceChildren(
    el("div", { class: "card intro-card" },
      el("h2", {}, "Emerging genes"),
      el("p", {},
        "The leaderboard score is built from how many lupus papers a gene has and " +
        "how strong its curated evidence is. Both grow with accumulated attention, " +
        "so a gene whose entire lupus literature is four years old cannot rank there " +
        "however fast it is moving. This tab selects on the opposite property: ",
        el("strong", {}, "how improbably recent a gene's lupus literature is."),
        " Only genes with at most " + fmt(m.max_papers) + " lupus papers are eligible — " +
        "the point is the ones the field has not caught up with yet."),
      el("p", { class: "sub" },
        `About ${Math.round(m.corpus_recent_share * 100)}% of the whole lupus corpus was ` +
        `published between ${m.recent_cutoff} and ${m.complete_year}. A gene qualifies ` +
        "when its own share would be improbable at " + `p < ${m.p_threshold}` +
        " had its papers simply fallen where the corpus fell — a binomial tail " +
        "probability against that baseline."),
      el("p", { class: "sub" },
        "That test is the gate, not the ranking. Statistical power grows with sample " +
        "size, so ranking on it would put the best-published genes on top — which is " +
        "the opposite of the question. The ", el("strong", {}, "emergence score"),
        " is the effect size instead: the recent share, shrunk for how few papers it " +
        "rests on (a Wilson score lower bound). A gene with 18 of 19 papers in the " +
        "window beats one with 66 of 107, and 5 of 5 does not beat either."),
      el("p", { class: "sub" },
        "This is a map of where attention is moving, not a ranked list of things to work " +
        "on. A gene here has, by construction, thin evidence — that is what makes it new. " +
        "The ",
        el("button", { class: "linklike", onclick: () => switchView("targets") },
          "Target opportunities"),
        " tab asks the second question, and gates hard on evidence when it does."),
      el("p", { class: "sub" },
        "PubTator resolves gene synonyms, so a gene whose alias is also a trending " +
        "acronym inherits that acronym's papers — in a literature this small, one " +
        "collision is enough to manufacture a top-ranked gene. Every gene is checked " +
        "against an independent keyword search of the same corpus and flagged when the " +
        "two disagree; " + (m.excluded.length ? m.excluded.length : "no") +
        " confirmed collisions are excluded outright" +
        (m.excluded.length ? " — " + m.excluded.map(e => e.symbol).join(", ") : "") + ".")),
    el("div", { class: "kpi-row" },
      statTile("Emerging genes", fmt(state.emerging.length),
        `p < ${m.p_threshold}, at most ${fmt(m.max_papers)} lupus papers`),
      statTile("New to lupus", fmt(brandNew),
        `first lupus paper in ${m.recent_cutoff} or later`),
      statTile("Borrowed biology", fmt(borrowed),
        `well studied elsewhere, new here`),
      statTile("Top", state.emerging[0] ? state.emerging[0].symbol : "—",
        state.emerging[0]
          ? `emergence ${state.emerging[0].emergence.toFixed(1)} · ` +
            `${fmt(state.emerging[0].papers)} papers`
          : "")),
    el("div", { class: "card" },
      el("h2", {}, "Two axes"),
      el("p", { class: "sub" },
        "Horizontally: how much biology as a whole has studied this gene, from its total " +
        "PubMed footprint. Vertically: how much of its lupus literature is recent. The " +
        "split lines sit at " + fmt(m.maturity_split) + " papers and " +
        Math.round(m.novelty_split * 100) + "%. Every gene plotted is already above the " +
        Math.round(m.corpus_recent_share * 100) + "% corpus average — that is the entry " +
        "condition — so the vertical axis starts at the lowest gene rather than at zero. " +
        "Dot size is emergence; faded dots are the ones whose mention counts an " +
        "independent search did not corroborate. Click any gene."),
      el("div", { class: "legend quadrant-legend", id: "emerging-legend" }),
      el("div", { id: "emerging-chart" })),
    el("div", { class: "filter-row" },
      search, quadSelect,
      check("newOnly", "New to lupus",
        `No lupus paper before ${m.recent_cutoff}`),
      check("openOnly", "No SLE drug",
        "Genes with no drug or trial candidate against them in lupus"),
      check("hideUnverified", "Hide unverified",
        "Drop genes whose PubTator mention count an independent keyword search did not corroborate"),
      el("span", { class: "count", id: "emerging-count" })),
    el("div", { class: "card" },
      el("div", { class: "table-scroll" },
        el("table", { class: "data" },
          el("thead", {}, el("tr", {},
            el("th", { class: "num" }, "#"),
            el("th", {}, "Gene"),
            el("th", {}, "Emergence"),
            el("th", {}, "Lupus papers"),
            el("th", {}, "History"),
            el("th", { class: "num" }, "PubMed"),
            el("th", {}, "Quadrant"))),
          el("tbody", { id: "emerging-tbody" })))),
  );
  renderEmergingBody();
}

function renderEmergingBody() {
  const m = state.emergingMeta;
  const rows = emergingRows();
  document.getElementById("emerging-count").textContent =
    `${fmt(rows.length)} of ${fmt(state.emerging.length)} genes`;

  const counts = {};
  for (const g of state.emerging) counts[g.quadrant] = (counts[g.quadrant] || 0) + 1;
  document.getElementById("emerging-legend").replaceChildren(
    ...m.quadrants.map(q => {
      const active = emergingFilter.quadrant === q.id;
      const item = el("button", { class: `legend-btn${active ? " active" : ""}`,
        title: q.blurb,
        onclick: () => {
          emergingFilter.quadrant = active ? "all" : q.id;
          renderEmergingBody();
        } },
        el("span", { class: "swatch", style: `background:${QUADRANT_COLORS[q.id]}` }),
        `${q.label} (${counts[q.id] || 0})`);
      return item;
    }));
  document.getElementById("emerging-chart").replaceChildren(quadrantChart(rows));

  const quadLabel = Object.fromEntries(m.quadrants.map(q => [q.id, q.label]));
  const tbody = document.getElementById("emerging-tbody");
  if (!rows.length) {
    tbody.replaceChildren(el("tr", {}, el("td", { colspan: "7", class: "empty-state" },
      el("p", {}, "No genes match these filters."),
      el("button", { class: "back-btn", onclick: () => {
        emergingFilter.q = "";
        emergingFilter.quadrant = "all";
        for (const k of ["newOnly", "openOnly", "hideUnverified"]) emergingFilter[k] = false;
        renderEmergingView();
      } }, "Clear filters"))));
    return;
  }
  tbody.replaceChildren(...rows.map(g => el("tr", { class: "gene-row", tabindex: "0", role: "button",
    onclick: () => showEmergingDetail(g.symbol),
    onkeydown: ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); showEmergingDetail(g.symbol); } } },
    el("td", { class: "num muted" }, String(g.rank)),
    el("td", {},
      el("div", { class: "gene-symbol" }, g.symbol),
      el("div", { class: "gene-name" }, g.name),
      (g.drug_stage || g.unverified)
        ? el("div", { class: "flag-row" }, drugBadge(g),
            g.unverified ? corroborationNote(g) : null)
        : null),
    el("td", {}, el("div", { class: "score-cell" },
      el("div", { class: "bar-track" },
        el("div", { class: "bar-fill",
          style: `width:${g.emergence}%;` +
                 `background:${QUADRANT_COLORS[g.quadrant] || "var(--muted)"}` })),
      el("span", { class: "val" }, g.emergence.toFixed(1)))),
    el("td", { class: "muted" },
      `${fmt(g.recent_papers)} of ${fmt(g.papers)}`,
      el("div", { class: "cell-sub" }, `${Math.round(g.recent_share * 100)}% since ${m.recent_cutoff}`)),
    el("td", {}, el("div", { class: "trend-cell" },
      el("div", { class: "spark-gap" }, sparkline(g)),
      el("span", { class: "trend-tag" }, `first seen ${g.debut}`))),
    el("td", { class: "num muted" }, g.pubmed_total == null ? "—" : fmt(g.pubmed_total)),
    el("td", {}, el("span", { class: "badge quadrant-badge",
      style: `border-color:${QUADRANT_COLORS[g.quadrant] || "var(--muted)"};` +
             `color:${QUADRANT_COLORS[g.quadrant] || "var(--muted)"}` },
      quadLabel[g.quadrant] || "unplaced")))));
}

function showEmergingDetail(symbol) {
  const g = state.emerging.find(x => x.symbol === symbol);
  if (!g) return;
  setHash({ emerging: symbol });
  const m = state.emergingMeta;
  const quad = m.quadrants.find(q => q.id === g.quadrant);
  const inLeaderboard = state.geneBySymbol.has(g.symbol);
  const target = state.targets.find(t => t.symbol === g.symbol);
  const pre = g.papers - g.recent_papers;

  // replaceChildren stringifies non-nodes, so a `null` branch would render the
  // word "null" — unlike el(), which drops them.
  document.getElementById("view-detail").replaceChildren(...[
    el("button", { class: "back-btn", onclick: () => switchView("emerging") },
      "← Back to emerging genes"),
    el("div", { class: "detail-head" },
      el("h2", {}, g.symbol),
      el("span", { class: "muted" }, g.name),
      corroborationNote(g),
      el("a", { href: `https://www.ncbi.nlm.nih.gov/gene/${g.entrez}`,
        target: "_blank", rel: "noopener" }, "NCBI Gene ↗"),
      el("a", { href: `https://platform.opentargets.org/target/${g.symbol}`,
        target: "_blank", rel: "noopener" }, "Open Targets ↗")),
    el("div", { class: "kpi-row" },
      statTile("Emergence", g.emergence.toFixed(1),
        `out of 100 · rank #${g.rank} of ${fmt(state.emerging.length)}`),
      statTile("Lupus papers", fmt(g.papers),
        `${fmt(g.recent_papers)} since ${m.recent_cutoff} · ${fmt(pre)} before`),
      statTile("First lupus paper", String(g.debut),
        g.debut >= m.recent_cutoff
          ? "nothing before the recent window"
          : `${fmt(pre)} paper${pre === 1 ? "" : "s"} before ${m.recent_cutoff}`),
      statTile("PubMed footprint", g.pubmed_total == null ? "—" : fmt(g.pubmed_total),
        "papers on this gene across all of biology")),
    quad
      ? el("div", { class: "card" },
          el("h2", {}, quad.label),
          el("p", { class: "sub" }, quad.blurb),
          el("p", { class: "sub" },
            `${g.symbol} sits here because ${Math.round(g.recent_share * 100)}% of its ` +
            `lupus papers are from ${m.recent_cutoff} or later (the split is ` +
            `${Math.round(m.novelty_split * 100)}%), and PubMed holds ` +
            `${fmt(g.pubmed_total)} papers on it overall (the split is ` +
            `${fmt(m.maturity_split)}).`))
      : null,
    el("div", { class: "card" },
      el("h2", {}, "Lupus papers per year"),
      el("p", { class: "sub" },
        `PubTator gene mentions across the lupus corpus. ${m.max_year} is still in ` +
        "progress and is excluded from the statistics above."),
      yearColumnChart(g.year_counts, { label: `${g.symbol} lupus papers per year` })),
    el("div", { class: "card" },
      el("h2", {}, "Why this counts as emerging"),
      el("p", { class: "sub" },
        `${Math.round(m.corpus_recent_share * 100)}% of the lupus corpus was published ` +
        `between ${m.recent_cutoff} and ${m.complete_year}. If ${g.symbol}'s ` +
        `${fmt(g.papers)} papers had landed in those years at the same rate, about ` +
        `${Math.round(g.papers * m.corpus_recent_share)} would be recent. ` +
        `${fmt(g.recent_papers)} are. The chance of that happening by accident is about ` +
        (g.surprise >= 5 ? "1 in 10" + supers(Math.round(g.surprise))
                         : `1 in ${fmt(Math.round(10 ** g.surprise))}`) + "."),
      el("p", { class: "sub" },
        `That test decides whether ${g.symbol} belongs here at all. Its position in the ` +
        `list comes from the effect size: ${fmt(g.recent_papers)} of ${fmt(g.papers)} is ` +
        `${Math.round(g.recent_share * 100)}%, which ${fmt(g.papers)} papers support down ` +
        `to ${g.emergence.toFixed(1)}% with 95% confidence — that lower bound is the ` +
        "emergence score, so a large share resting on very few papers cannot run away " +
        "with the ranking."),
      g.corroboration != null
        ? el("p", { class: "sub" },
            `Cross-check: searching PubMed's own index for "${g.symbol}"` +
            ((g.aliases || []).length ? ` or its aliases (${g.aliases.join(", ")})` : "") +
            ` inside the same lupus corpus returns ${fmt(g.pubmed_lupus)} papers, against ` +
            `PubTator's ${fmt(g.papers)} mentions — a ratio of ${g.corroboration}×. ` +
            (g.unverified
              ? "That is outside the expected range, so treat the mention count with " +
                "suspicion: PubTator may be resolving an ambiguous alias onto this gene."
              : "The two independent counts agree, so the mentions look real."))
        : null),
    g.articles.length
      ? el("div", { class: "card" },
          el("h2", {}, "The recent papers"),
          el("p", { class: "sub" },
            `The ${g.articles.length} most recent lupus papers mentioning ${g.symbol} — ` +
            "the fastest way to judge for yourself whether this is a real signal."),
          el("ul", { class: "article-list" },
            ...g.articles.map(a => el("li", {},
              el("a", { href: `https://pubmed.ncbi.nlm.nih.gov/${a.pmid}/`,
                target: "_blank", rel: "noopener" }, a.title || `PMID ${a.pmid}`),
              el("div", { class: "muted" }, `${a.journal || "—"} · ${a.year || "—"}`)))))
      : null,
    (g.drugs || []).length ? drugCard(g) : null,
    el("div", { class: "card" },
      el("h2", {}, "Elsewhere on this site"),
      el("p", { class: "sub" },
        `Open Targets scores ${g.symbol}'s SLE association at ${g.ot_score.toFixed(2)}. ` +
        (g.lit_rank
          ? `It also ranks #${g.lit_rank} on the literature leaderboard.`
          : `It ranks outside the published top ${fmt(state.meta.genes_shown)} on the ` +
            "leaderboard — which is the point of this tab.")),
      el("div", { class: "detail-links" },
        inLeaderboard
          ? el("button", { class: "back-btn", onclick: () => showDetail(g.symbol) },
              `Literature page for ${g.symbol} →`)
          : null,
        target
          ? el("button", { class: "back-btn", onclick: () => showTargetDetail(g.symbol) },
              `Target opportunity score for ${g.symbol} →`)
          : null,
        // The network answers the question this tab raises but cannot: a gene
        // is new here, so who is it new *alongside*? EXT1, NELL1 and SEMA3B all
        // land next to PLA2R1, which is why they arrived together.
        inNetwork(g.symbol)
          ? el("button", { class: "back-btn", onclick: () => showNetworkDetail(g.symbol) },
              `Where ${g.symbol} sits in the co-mention network →`)
          : null,
        el("a", { class: "back-btn",
          href: `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(`(${g.symbol}) AND (lupus)`)}&sort=date`,
          target: "_blank", rel: "noopener" }, "Search PubMed ↗"))),
  ].filter(Boolean));
  switchView("detail", { keepHash: true });
  window.scrollTo({ top: 0 });
}

/* ---------- co-mention network ---------- */
/* Every edge here exists because PubTator found two genes in the same abstract.
   Nothing else feeds the structure — see pipeline/build_network.py. Layout is
   precomputed and shipped, so the map is the same on every visit and can be
   learned; the browser only draws it. */
const MODULE_VARS = ["--mod-1", "--mod-2", "--mod-3", "--mod-4", "--mod-5",
                     "--mod-6", "--mod-7", "--mod-8", "--mod-9", "--mod-10",
                     "--mod-11"];
const networkFilter = { q: "", perNode: 4, module: "all",
                        colourEdgesByAge: false, showLabels: true };

/* Whether the network tab has anything to say about a gene: it is either on
   the map, or small enough to be off it but still co-mentioned often enough to
   be placed beside it. */
function inNetwork(symbol) {
  return !!state.network
    && (state.networkBySymbol.has(symbol) || !!state.network.neighbours[symbol]);
}

function moduleColour(moduleId) {
  const m = state.network.modules[moduleId];
  if (!m || !m.coloured) return "var(--muted)";
  return `var(${MODULE_VARS[moduleId % MODULE_VARS.length]})`;
}

/* The shipped edge list is each gene's strongest k; the slider tightens that
   client-side rather than re-fetching, so it stays a redraw and never a
   relayout — node positions must not move when you thin the edges. */
function networkEdges() {
  const { edges } = state.network;
  const perNode = networkFilter.perNode;
  if (perNode >= state.network.edges_per_node) return edges;
  const kept = new Set();
  const byNode = new Map();
  edges.forEach((e, i) => {
    for (const n of [e[0], e[1]]) {
      if (!byNode.has(n)) byNode.set(n, []);
      byNode.get(n).push(i);
    }
  });
  for (const list of byNode.values()) {
    list.sort((x, y) => edges[y][3] - edges[x][3]);
    for (const i of list.slice(0, perNode)) kept.add(i);
  }
  return [...kept].sort((a, b) => a - b).map(i => edges[i]);
}

/* Old → new on the same sequential ramp the evidence strips use. */
function edgeAgeColour(recentShare) {
  if (recentShare >= 0.5) return "var(--series-2)";
  if (recentShare >= 0.3) return "var(--seq-350)";
  return "var(--seq-150)";
}

function networkMap(focus) {
  const net = state.network;
  const W = net.width, H = net.height;
  const nodes = net.nodes;
  const edges = networkEdges();
  const drawn = nodes.filter(n => n.x != null);
  const papers = drawn.map(n => n.papers);
  const logMin = Math.log(Math.min(...papers)), logMax = Math.log(Math.max(...papers));
  const radius = n => 3.5 + 6.5 * ((Math.log(n.papers) - logMin) / (logMax - logMin || 1));

  const adjacency = new Map();
  for (const [a, b] of edges) {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a).add(b);
    adjacency.get(b).add(a);
  }
  const focusIndex = focus == null ? null : nodes.findIndex(n => n.symbol === focus);
  const lit = focusIndex == null ? null
    : new Set([focusIndex, ...(adjacency.get(focusIndex) || [])]);
  const dimmedByModule = networkFilter.module !== "all";

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "network-svg",
    role: "img", "aria-label":
      `Co-mention network: ${drawn.length} genes, ${edges.length} edges, ` +
      `laid out so that genes appearing in the same papers sit together` });

  const edgeLayer = svgEl("g", { class: "edge-layer" });
  for (const [a, b, co, npmi, recent] of edges) {
    const na = nodes[a], nb = nodes[b];
    if (na.x == null || nb.x == null) continue;
    const inFocus = !lit || (lit.has(a) && lit.has(b));
    const inModule = !dimmedByModule
      || String(na.module) === networkFilter.module
      || String(nb.module) === networkFilter.module;
    const line = svgEl("line", { class: "net-edge", x1: na.x, y1: na.y, x2: nb.x, y2: nb.y,
      stroke: networkFilter.colourEdgesByAge ? edgeAgeColour(recent) : "var(--baseline)",
      "stroke-width": (0.5 + 2.2 * npmi).toFixed(2),
      opacity: (inFocus && inModule) ? (networkFilter.colourEdgesByAge ? 0.75 : 0.45) : 0.06 });
    line.addEventListener("pointermove", ev =>
      showTooltip(ev.clientX, ev.clientY, `${na.symbol} — ${nb.symbol}`, [
        { value: fmt(co), label: co === 1 ? "paper mentions both" : "papers mention both" },
        { value: npmi.toFixed(2), label: "association strength (npmi)" },
        { value: `${Math.round(recent * 100)}%`,
          label: `of those are from ${net.recent_from}–${net.complete_year}` },
      ]));
    line.addEventListener("pointerleave", hideTooltip);
    edgeLayer.append(line);
  }
  svg.append(edgeLayer);

  const nodeLayer = svgEl("g", { class: "node-layer" });
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.x == null) continue;
    const inFocus = !lit || lit.has(i);
    const inModule = !dimmedByModule || String(n.module) === networkFilter.module;
    const dot = svgEl("circle", { class: "net-node", cx: n.x, cy: n.y, r: radius(n),
      fill: moduleColour(n.module),
      stroke: n.drug_stage ? "var(--ink)" : "var(--surface)",
      "stroke-width": n.drug_stage ? 1.6 : 0.8,
      opacity: (inFocus && inModule) ? 1 : 0.12 });
    dot.addEventListener("pointermove", ev => {
      const mod = net.modules[n.module];
      showTooltip(ev.clientX, ev.clientY, `${n.symbol} — ${n.name}`, [
        { value: fmt(n.papers), label: "lupus papers", color: moduleColour(n.module) },
        { value: String(n.degree), label: "co-mention partners" },
        { value: (mod && mod.label) || `module ${n.module}`, label: `${mod ? mod.size : 0} genes` },
        ...(n.drug_stage ? [{ value: (STAGE_BADGE[n.drug_stage] || [n.drug_stage])[0],
                             label: "SLE drug or candidate" }] : []),
      ]);
    });
    dot.addEventListener("pointerleave", hideTooltip);
    dot.addEventListener("click", () => showNetworkDetail(n.symbol));
    nodeLayer.append(dot);
  }
  svg.append(nodeLayer);

  // Module captions at each module's centre of mass. These are what make a
  // 300-node picture readable — without them it is a coloured cloud.
  if (networkFilter.showLabels) {
    const labelLayer = svgEl("g", { class: "module-label-layer" });
    // Captions sit on their module's centre of mass, which puts the two
    // densest modules' text on top of each other. Nudge each one clear of the
    // ones already placed — biggest module first, so the most important
    // caption keeps the spot it earned.
    const placed = [];
    for (const mod of net.modules) {
      if (!mod.coloured || !mod.label) continue;
      const members = mod.genes.map(s => state.networkBySymbol.get(s)).filter(n => n && n.x != null);
      if (members.length < 3) continue;
      const cx = members.reduce((a, n) => a + n.x, 0) / members.length;
      let cy = members.reduce((a, n) => a + n.y, 0) / members.length;
      for (let guard = 0; guard < 24; guard++) {
        const clash = placed.find(p => Math.abs(p.x - cx) < 190 && Math.abs(p.y - cy) < 15);
        if (!clash) break;
        cy = clash.y + 16;
      }
      placed.push({ x: cx, y: cy });
      const faded = dimmedByModule && String(mod.id) !== networkFilter.module;
      labelLayer.append(svgEl("text", { class: "module-caption", x: cx, y: cy,
        "text-anchor": "middle", fill: moduleColour(mod.id),
        opacity: faded ? 0.15 : 1 }, mod.label.length > 34 ? mod.label.slice(0, 32) + "…" : mod.label));
    }
    svg.append(labelLayer);
  }

  if (focus) {
    const n = state.networkBySymbol.get(focus);
    if (n && n.x != null) {
      svg.append(svgEl("circle", { class: "net-focus-ring", cx: n.x, cy: n.y,
        r: radius(n) + 6, fill: "none", stroke: "var(--ink)", "stroke-width": 1.5 }));
      svg.append(svgEl("text", { class: "net-focus-label", x: n.x, y: n.y - radius(n) - 11,
        "text-anchor": "middle" }, n.symbol));
    }
  }
  return el("div", { class: "chart-box network-box" }, svg);
}

function renderNetworkView() {
  const view = document.getElementById("view-network");
  const net = state.network;
  const named = net.modules.filter(m => m.coloured && m.label);
  const offMap = Object.keys(net.neighbours).length;

  const search = el("input", { type: "search", value: networkFilter.q,
    placeholder: "Find a gene…", list: "network-options",
    oninput: e => { networkFilter.q = e.target.value; renderNetworkBody(); } });
  const datalist = el("datalist", { id: "network-options" },
    ...net.nodes.map(n => el("option", { value: n.symbol })),
    ...Object.keys(net.neighbours).map(s => el("option", { value: s })));

  const slider = el("input", { type: "range", min: "1", max: String(net.edges_per_node),
    step: "1", value: String(networkFilter.perNode), "aria-label": "Edges kept per gene",
    oninput: e => {
      networkFilter.perNode = Number(e.target.value);
      document.getElementById("per-node-val").textContent = e.target.value;
      renderNetworkBody();
    } });
  const moduleSelect = el("select", { "aria-label": "Module",
    onchange: e => { networkFilter.module = e.target.value; renderNetworkBody(); } },
    ...[["all", "All modules"],
        ...net.modules.filter(m => m.size >= 3)
          .map(m => [String(m.id), `${m.label || `Module ${m.id}`} (${m.size})`])]
      .map(([v, text]) => {
        const o = el("option", { value: v }, text);
        if (networkFilter.module === v) o.selected = true;
        return o;
      }));
  const check = (key, label, title) => {
    const box = el("input", { type: "checkbox",
      onchange: e => { networkFilter[key] = e.target.checked; renderNetworkBody(); } });
    box.checked = networkFilter[key];
    return el("label", { class: "check", title }, box, label);
  };

  view.replaceChildren(
    el("div", { class: "card intro-card" },
      el("h2", {}, "Co-mention network"),
      el("p", {},
        "Two genes are joined here because papers mention them together. That is the " +
        "whole of it — ", el("strong", {}, "every edge, weight and module on this map " +
        "comes from the mention data and nothing else."),
        " No interaction database, no pathway membership, no Open Targets. Even the " +
        "gene set is the " + fmt(net.nodes.length) + " genes with the most lupus papers " +
        `(${fmt(net.paper_floor)} or more), rather than the leaderboard's top 300, ` +
        "because that ranking is 30% Open Targets and would have let a curated database " +
        "decide who appears on a map billed as pure co-mention."),
      el("p", { class: "sub" },
        "Edge weight is the raw count of papers mentioning both genes. Which edges " +
        "survive is a different question: the most-published genes co-occur constantly " +
        "whatever the biology — IL6 and TNF share 754 papers and it means nothing — so " +
        "each pair is first gated on a hypergeometric tail probability (is this more " +
        "overlap than chance?) and then kept on normalized pointwise mutual information " +
        "(how much more?). Each gene keeps its strongest few partners and the union is " +
        "the map, which is why no hub swallows the picture."),
      el("p", { class: "sub" },
        "Modules are found by modularity optimisation over those edges, then named by asking " +
        "g:Profiler what they have in common — the labels are annotation laid over " +
        "structure that co-mention had already produced, not an input to it. A module " +
        "with no caption is one no ontology term fits, which is usually the interesting " +
        "case: an antibody panel, a GWAS locus, a clinical syndrome."),
      el("p", { class: "sub" },
        el("strong", {}, "Co-mention is not interaction."),
        " TG and TPO sit together because both are on a thyroid antibody panel; BLK and " +
        "FAM167A because they share one linkage block. This is a map of how the " +
        "literature groups genes — part biology, part assay panel, part GWAS locus. The ",
        el("button", { class: "linklike", onclick: () => switchView("pathways") }, "Pathways"),
        " tab is the curated counterpart, and the disagreements between them are the " +
        "point.")),
    el("div", { class: "kpi-row" },
      statTile("Genes on the map", fmt(net.nodes.length - net.isolated.length),
        `${fmt(net.paper_floor)}+ lupus papers each`),
      statTile("Co-mention edges", fmt(net.edges.length),
        `p < ${net.p_threshold}, top ${net.edges_per_node} per gene`),
      statTile("Modules", fmt(net.modules.filter(m => m.size >= 3).length),
        `${fmt(net.modules.filter(m => m.label).length)} matched a named term`),
      statTile("Off-map neighbourhoods", fmt(offMap),
        "genes too small for the map, still placeable")),
    el("div", { class: "card" },
      el("div", { class: "legend quadrant-legend", id: "network-legend" }),
      el("div", { class: "filter-row network-controls" },
        search, datalist, moduleSelect,
        el("label", { class: "check net-slider",
          title: "Each gene keeps this many of its strongest partners" },
          "Edges per gene", slider, el("span", { id: "per-node-val" }, String(networkFilter.perNode))),
        check("colourEdgesByAge", "Colour edges by age",
          `Orange where most co-mentions are from ${net.recent_from}–${net.complete_year}`),
        check("showLabels", "Module captions", "Show the named modules on the map"),
        el("span", { class: "count", id: "network-count" })),
      el("div", { id: "network-map" }),
      el("p", { class: "sub net-key" },
        "Dot size is lupus papers; colour is module; a dark ring means an SLE drug or " +
        "trial candidate exists against that gene. Hover a gene to isolate its " +
        "neighbourhood, click for its full ego network.")),
    el("div", { class: "card" },
      el("h2", {}, "Modules"),
      el("p", { class: "sub" },
        "Found from the edges, then named. “vs the map” means the term is " +
        "enriched against the other " + fmt(net.nodes.length - 1) + " genes here — what " +
        "makes the module different from the rest of the board. “vs the genome” " +
        "is the looser fallback used when nothing clears that bar."),
      el("div", { class: "table-scroll" },
        el("table", { class: "data" },
          el("thead", {}, el("tr", {},
            el("th", {}, "Module"), el("th", { class: "num" }, "Genes"),
            el("th", {}, "Enriched term"), el("th", {}, "Members"))),
          el("tbody", { id: "network-modules" })))),
    net.isolated.length
      ? el("div", { class: "card" },
          el("h2", {}, "No strong partners"),
          el("p", { class: "sub" },
            `${net.isolated.length} genes on the board have no co-mention that clears ` +
            "the threshold. Some are studied alone (autoantibody targets, single " +
            "biomarkers); some are simply named in passing across unrelated papers."),
          el("div", { class: "chip-row" },
            ...net.isolated.map(s => el("button", { class: "chip",
              onclick: () => showNetworkDetail(s) }, s))))
      : null,
  );
  renderNetworkBody();
}

function renderNetworkBody() {
  const net = state.network;
  const q = networkFilter.q.trim().toUpperCase();
  const focus = q && (state.networkBySymbol.has(q) || net.neighbours[q]) ? q : null;
  const edges = networkEdges();
  document.getElementById("network-count").textContent =
    `${fmt(edges.length)} edges shown`;

  document.getElementById("network-legend").replaceChildren(
    ...net.modules.filter(m => m.coloured).map(m => {
      const active = networkFilter.module === String(m.id);
      return el("button", { class: `legend-btn${active ? " active" : ""}`,
        title: m.genes.join(", "),
        onclick: () => {
          networkFilter.module = active ? "all" : String(m.id);
          renderNetworkBody();
        } },
        el("span", { class: "swatch", style: `background:${moduleColour(m.id)}` }),
        `${m.label || `Module ${m.id}`} (${m.size})`);
    }));

  document.getElementById("network-map").replaceChildren(
    networkMap(focus && state.networkBySymbol.has(focus) ? focus : null));

  document.getElementById("network-modules").replaceChildren(
    ...net.modules.filter(m => m.size >= 3).map(m => el("tr", {},
      el("td", {},
        el("span", { class: "swatch", style: `background:${moduleColour(m.id)}` }),
        m.label || el("span", { class: "muted" }, "no term fits")),
      el("td", { class: "num muted" }, String(m.size)),
      el("td", { class: "muted" }, m.label
        ? `${m.source} · p = ${m.p.toExponential(1)} · vs the ${m.scope === "map" ? "map" : "genome"}`
        : "—"),
      el("td", {}, el("div", { class: "module-members" },
        ...m.genes.map(s => el("button", { class: "chip",
          onclick: () => showNetworkDetail(s) }, s)))))));
}

function showNetworkDetail(symbol) {
  const net = state.network;
  const node = state.networkBySymbol.get(symbol);
  const offMap = net.neighbours[symbol];
  if (!node && !offMap) return;
  setHash({ network: symbol });

  // Partners come from the full significant edge set, not the thinned view:
  // the slider is a decluttering control for the picture, not a claim that the
  // dropped partners stopped existing.
  const partners = [];
  if (node) {
    const self = net.nodes.indexOf(node);
    for (const [a, b, co, npmi, recent] of net.edges) {
      if (a === self) partners.push({ other: net.nodes[b], co, npmi, recent });
      else if (b === self) partners.push({ other: net.nodes[a], co, npmi, recent });
    }
    partners.sort((x, y) => y.npmi - x.npmi);
  }
  const mod = node && net.modules[node.module];
  const emergingRow = state.emerging.find(g => g.symbol === symbol);

  // Off-map genes have no npmi or recency — they were never scored as edges —
  // so those columns are dropped rather than filled with em dashes.
  const partnerTable = (rows, scored) => el("div", { class: "table-scroll" },
    el("table", { class: "data" },
      el("thead", {}, el("tr", {},
        el("th", {}, "Gene"), el("th", { class: "num" }, "Shared papers"),
        ...(scored ? [el("th", {}, "Strength")] : []),
        el("th", {}, "Module"),
        ...(scored ? [el("th", {}, "Recent")] : []))),
      el("tbody", {}, ...rows)));

  document.getElementById("view-detail").replaceChildren(...[
    el("button", { class: "back-btn", onclick: () => switchView("network") },
      "← Back to the network"),
    el("div", { class: "detail-head" },
      el("h2", {}, symbol),
      el("span", { class: "muted" }, node ? node.name : ""),
      node && node.drug_stage ? drugBadge(node) : null,
      node
        ? el("a", { href: `https://www.ncbi.nlm.nih.gov/gene/${node.entrez}`,
            target: "_blank", rel: "noopener" }, "NCBI Gene ↗")
        : null),
    node
      ? el("div", { class: "kpi-row" },
          statTile("Co-mention partners", String(node.degree),
            `above p < ${net.p_threshold}`),
          statTile("Lupus papers", fmt(node.papers), "PubTator mentions in the corpus"),
          statTile("Module", mod && mod.label ? mod.label : `#${node.module}`,
            `${mod ? mod.size : 0} genes`),
          statTile("Strongest partner", partners.length ? partners[0].other.symbol : "—",
            partners.length ? `${fmt(partners[0].co)} shared papers` : "no edge above threshold"))
      : el("div", { class: "kpi-row" },
          statTile("Lupus papers", fmt(offMap.papers), "too few for the map itself"),
          statTile("Partners on the map", String(offMap.partners.length),
            `at least ${net.ego_min_co} shared papers each`)),
    !node
      ? el("div", { class: "card" },
          el("h2", {}, "Off the map, but placeable"),
          el("p", { class: "sub" },
            `${symbol} has ${fmt(offMap.papers)} lupus papers — too few to earn a place ` +
            `among the top ${fmt(net.nodes.length)}. Its co-mentions with genes that are ` +
            "on the map still say where it sits, which is often exactly what you want " +
            "for a gene that has only just appeared."))
      : null,
    (node && partners.length) || offMap
      ? el("div", { class: "card" },
          el("h2", {}, "Neighbourhood"),
          el("p", { class: "sub" },
            node
              ? "Every gene sharing significantly more papers with " + symbol + " than " +
                "chance would give. Strength is npmi; the last column is how much of the " +
                `overlap is from ${net.recent_from}–${net.complete_year}.`
              : `Genes on the map that appear alongside ${symbol}, by shared paper count.`),
          node
            ? partnerTable(partners.map(p => el("tr", { class: "gene-row", tabindex: "0",
                role: "button",
                onclick: () => showNetworkDetail(p.other.symbol),
                onkeydown: ev => { if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault(); showNetworkDetail(p.other.symbol); } } },
                el("td", {}, el("div", { class: "gene-symbol" }, p.other.symbol),
                  el("div", { class: "gene-name" }, p.other.name)),
                el("td", { class: "num" }, fmt(p.co)),
                el("td", {}, el("div", { class: "score-cell" },
                  el("div", { class: "bar-track" },
                    el("div", { class: "bar-fill",
                      style: `width:${p.npmi * 100}%;background:${moduleColour(p.other.module)}` })),
                  el("span", { class: "val" }, p.npmi.toFixed(2)))),
                el("td", { class: "muted" },
                  (net.modules[p.other.module] || {}).label || `#${p.other.module}`),
                el("td", { class: "muted" }, `${Math.round(p.recent * 100)}%`))), true)
            : partnerTable(offMap.partners.map(([idx, co]) => {
                const other = net.nodes[idx];
                return el("tr", { class: "gene-row", tabindex: "0", role: "button",
                  onclick: () => showNetworkDetail(other.symbol),
                  onkeydown: ev => { if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault(); showNetworkDetail(other.symbol); } } },
                  el("td", {}, el("div", { class: "gene-symbol" }, other.symbol),
                    el("div", { class: "gene-name" }, other.name)),
                  el("td", { class: "num" }, fmt(co)),
                  el("td", { class: "muted" },
                    (net.modules[other.module] || {}).label || `#${other.module}`));
              }), false))
      : el("div", { class: "card" },
          el("h2", {}, "No strong partners"),
          el("p", { class: "sub" },
            `No gene shares enough papers with ${symbol} to clear p < ${net.p_threshold}. ` +
            "That is a real finding rather than missing data: it is studied on its own.")),
    node && mod && mod.genes.length > 1
      ? el("div", { class: "card" },
          el("h2", {}, mod.label || `Module ${mod.id}`),
          el("p", { class: "sub" },
            mod.label
              ? `${mod.size} genes the literature keeps together. g:Profiler matches them ` +
                `to ${mod.label} (${mod.source}, p = ${mod.p.toExponential(1)}, ` +
                `against the ${mod.scope === "map" ? "rest of the map" : "genome"}).`
              : `${mod.size} genes the literature keeps together, with no ontology term ` +
                "that fits them — which usually means they share an assay, a locus or a " +
                "clinical presentation rather than a pathway."),
          el("div", { class: "chip-row" },
            ...mod.genes.map(s => el("button", {
              class: `chip${s === symbol ? " chip-current" : ""}`,
              onclick: () => showNetworkDetail(s) }, s))))
      : null,
    el("div", { class: "card" },
      el("h2", {}, "Elsewhere on this site"),
      el("div", { class: "detail-links" },
        state.geneBySymbol.has(symbol)
          ? el("button", { class: "back-btn", onclick: () => showDetail(symbol) },
              `Literature page for ${symbol} →`)
          : null,
        emergingRow
          ? el("button", { class: "back-btn", onclick: () => showEmergingDetail(symbol) },
              `Emerging: rank #${emergingRow.rank} →`)
          : null,
        state.targets.some(t => t.symbol === symbol)
          ? el("button", { class: "back-btn", onclick: () => showTargetDetail(symbol) },
              `Target opportunity score →`)
          : null,
        el("a", { class: "back-btn",
          href: `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(`(${symbol}) AND (lupus)`)}&sort=date`,
          target: "_blank", rel: "noopener" }, "Search PubMed ↗"))),
  ].filter(Boolean));
  switchView("detail", { keepHash: true });
  window.scrollTo({ top: 0 });
}

/* ---------- APOL1 in lupus ---------- */
/* Two questions, one tab. The table is the narrow one — which genes does the
   lupus literature name alongside APOL1 — and is built only from lupus papers.
   The map is the wide one, because the narrow answer cannot be drawn: 28 of the
   40 lupus papers PubTator tags with APOL1 name no other gene. So the map runs
   on the whole APOL1 corpus and splits it into two rings, lupus-linked inside
   and lupus-unseen outside. See pipeline/build_apol1.py. */
const APOL1_SORTS = {
  share:        { label: "Share of its lupus lit", get: r => r.share,
                  tie: r => [r.share_lb, r.co_lupus] },
  co_lupus:     { label: "Papers with APOL1", get: r => r.co_lupus,
                  tie: r => [r.share, r.share_lb] },
  lupus_papers: { label: "Its total lupus papers", get: r => r.lupus_papers,
                  tie: r => [r.share, r.co_lupus] },
};
/* Two kinds of highlight, because they behave differently: `focus` is sticky
   and set by clicking a gene on the map, `hover` is transient and set by
   passing over a table row. Only the sticky one earns a way out of it. */
const apol1Filter = { sort: "share", dir: "desc", showOuter: true,
                      showSpokes: true, allLabels: false, focus: null, hover: null };

function apol1ModuleColour(moduleId) {
  const mod = (state.apol1.network.modules || [])[moduleId];
  if (!mod || !mod.coloured || mod.unclustered) return "var(--muted)";
  return `var(${MODULE_VARS[moduleId % MODULE_VARS.length]})`;
}

function apol1SortedRows() {
  const { sort, dir } = apol1Filter;
  const spec = APOL1_SORTS[sort];
  const sign = dir === "desc" ? -1 : 1;
  return [...state.apol1.rows].sort((a, b) => {
    const primary = sign * (spec.get(a) - spec.get(b));
    if (primary) return primary;
    // Ties break on the other metrics before falling back to the symbol, so
    // two genes at 100% do not land in alphabetical order — the Wilson bound
    // shipped with the row is what separates 2-of-2 from 4-of-7.
    const ta = spec.tie(a), tb = spec.tie(b);
    for (let i = 0; i < ta.length; i++) if (ta[i] !== tb[i]) return sign * (ta[i] - tb[i]);
    return a.symbol.localeCompare(b.symbol);
  });
}

/* The rings are radial and the angle is not decoration: each module owns a
   wedge spanning both rings, so an empty inner arc inside a crowded outer one
   is the gap the tab is about. Layout is precomputed in the pipeline for the
   same reason the co-mention map's is — a picture that reshuffles cannot be
   learned. */
function apol1Map() {
  const net = state.apol1.network;
  const nodes = net.nodes;
  const focus = apol1Filter.hover || apol1Filter.focus;
  // Asymmetric: wedge captions are horizontal text hung off the outer ring, so
  // the box needs room for a caption's width on the sides and only a node
  // radius at the top and bottom.
  const padX = 176, padY = 64;
  const counts = nodes.map(n => n.co_apol1);
  const logMin = Math.log(Math.min(...counts)), logMax = Math.log(Math.max(...counts));
  const radius = n => n.ring === "hub" ? 13
    : 3.2 + 6.8 * ((Math.log(n.co_apol1) - logMin) / (logMax - logMin || 1));
  // A lupus co-mention counts for `lupus_weight` ordinary ones everywhere in
  // this figure, exactly as it does when the pipeline picks the outer ring.
  const weight = (co, lupus) => (co - lupus) + lupus * state.apol1.lupus_weight;

  const visible = i => apol1Filter.showOuter || nodes[i].ring !== "apol1";
  const adjacency = new Map();
  for (const [a, b] of net.edges) {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a).add(b);
    adjacency.get(b).add(a);
  }
  const focusIndex = focus == null ? null : nodes.findIndex(n => n.symbol === focus);
  const lit = focusIndex == null ? null
    : new Set([focusIndex, ...(adjacency.get(focusIndex) || [])]);

  const svg = svgEl("svg", {
    viewBox: `${-padX} ${-padY} ${net.width + 2 * padX} ${net.height + 2 * padY}`,
    class: "network-svg apol1-svg", role: "img", "aria-label":
      `APOL1 co-mention rings: ${nodes.filter(n => n.ring === "lupus").length} genes the ` +
      `lupus literature connects to APOL1 on the inner ring, ` +
      `${nodes.filter(n => n.ring === "apol1").length} connected only in the wider ` +
      "APOL1 literature on the outer ring" });

  // Wedges are laid out clockwise from the top, and the lupus-linked ring runs
  // out of members well before the circle closes, so its lower-left arc is
  // reliably empty — which is where its caption goes. The outer ring is full
  // all the way round and takes its caption outside the dashes instead.
  for (const [r, label, angle, inset] of [[net.r_inner, "lupus-linked", 2.53, -18],
                                          [net.r_outer, "APOL1 literature only", -1.571, -13]]) {
    if (r === net.r_outer && !apol1Filter.showOuter) continue;
    svg.append(svgEl("circle", { class: "apol1-ring", cx: net.cx, cy: net.cy, r,
      fill: "none", stroke: "var(--grid)", "stroke-width": 1,
      "stroke-dasharray": r === net.r_outer ? "3 5" : "none" }));
    svg.append(svgEl("text", { class: "apol1-ring-label",
      x: (net.cx + (r + inset) * Math.cos(angle)).toFixed(1),
      y: (net.cy + (r + inset) * Math.sin(angle)).toFixed(1),
      "text-anchor": "middle" }, label));
  }

  const edgeLayer = svgEl("g", { class: "edge-layer" });
  for (const [a, b, co, lupus, spoke] of net.edges) {
    if (!visible(a) || !visible(b)) continue;
    if (spoke && !apol1Filter.showSpokes) continue;
    const na = nodes[a], nb = nodes[b];
    const inFocus = !lit || (lit.has(a) && lit.has(b));
    const w = weight(co, lupus);
    const line = svgEl("line", { class: "net-edge", x1: na.x, y1: na.y, x2: nb.x, y2: nb.y,
      stroke: lupus ? "var(--series-2)" : "var(--baseline)",
      "stroke-width": Math.min(4.5, (spoke ? 0.35 : 0.6) + 0.5 * Math.sqrt(w)).toFixed(2),
      opacity: !inFocus ? 0.05 : lupus ? 0.8 : spoke ? 0.16 : 0.4 });
    line.addEventListener("pointermove", ev =>
      showTooltip(ev.clientX, ev.clientY, `${na.symbol} — ${nb.symbol}`, [
        { value: fmt(co), label: co === 1 ? "APOL1 paper mentions both"
                                          : "APOL1 papers mention both" },
        { value: fmt(lupus), label: "of those are lupus papers",
          color: lupus ? "var(--series-2)" : null },
        { value: weight(co, lupus).toFixed(1),
          label: `weighted (lupus papers count ${state.apol1.lupus_weight}×)` },
      ]));
    line.addEventListener("pointerleave", hideTooltip);
    edgeLayer.append(line);
  }
  svg.append(edgeLayer);

  const labelLayer = svgEl("g", { class: "apol1-gene-labels" });
  const nodeLayer = svgEl("g", { class: "node-layer" });
  nodes.forEach((n, i) => {
    if (!visible(i)) return;
    const inFocus = !lit || lit.has(i);
    const colour = n.ring === "hub" ? "var(--ink)" : apol1ModuleColour(n.module);
    const dot = svgEl("circle", { class: "net-node", cx: n.x, cy: n.y, r: radius(n),
      // Filled means the lupus literature has already made the connection;
      // hollow means only the wider APOL1 literature has.
      fill: n.ring === "apol1" ? "var(--surface)" : colour,
      stroke: colour, "stroke-width": n.ring === "apol1" ? 1.6 : 0.9,
      opacity: inFocus ? 1 : 0.12 });
    dot.addEventListener("pointermove", ev => {
      const mod = net.modules[n.module];
      showTooltip(ev.clientX, ev.clientY, `${n.symbol}${n.name ? ` — ${n.name}` : ""}`,
        n.ring === "hub"
          ? [{ value: fmt(n.co_apol1), label: "papers in the APOL1 corpus" },
             { value: fmt(n.co_lupus), label: "of those are lupus papers",
               color: "var(--series-2)" }]
          : [{ value: fmt(n.co_apol1), label: "APOL1 papers mention it" },
             { value: fmt(n.co_lupus), label: "of those are lupus papers",
               color: n.co_lupus ? "var(--series-2)" : null },
             { value: n.lupus_papers ? fmt(n.lupus_papers) : "—",
               label: "its own lupus papers" },
             { value: (mod && mod.label) || "unclustered",
               label: mod ? `${mod.size} genes in this wedge` : "" }]);
    });
    dot.addEventListener("pointerleave", hideTooltip);
    dot.addEventListener("click", () => {
      apol1Filter.focus = apol1Filter.focus === n.symbol ? null : n.symbol;
      renderApol1Body();
    });
    nodeLayer.append(dot);

    const named = n.ring !== "apol1" || apol1Filter.allLabels;
    if (!named || !inFocus) return;
    if (n.ring === "hub") {
      labelLayer.append(svgEl("text", { class: "apol1-hub-label", x: n.x,
        y: n.y + radius(n) + 15, "text-anchor": "middle" }, n.symbol));
      return;
    }
    const dx = n.x - net.cx, dy = n.y - net.cy;
    const len = Math.hypot(dx, dy) || 1;
    const off = radius(n) + 5 + (n.label_tier ? 14 : 0);
    labelLayer.append(svgEl("text", {
      class: `apol1-gene-label${n.ring === "lupus" ? " is-lupus" : ""}`,
      x: (n.x + (dx / len) * off).toFixed(1), y: (n.y + (dy / len) * off + 3.2).toFixed(1),
      "text-anchor": dx >= 0 ? "start" : "end" }, n.symbol));
  });
  svg.append(nodeLayer, labelLayer);

  const captionLayer = svgEl("g", { class: "module-label-layer" });
  for (const mod of net.modules) {
    if (!mod.label || mod.size < 3 || mod.start == null) continue;
    if (mod.unclustered && !apol1Filter.allLabels) continue;
    const mid = (mod.start + mod.end) / 2;
    const r = net.r_outer + 30;
    const x = net.cx + r * Math.cos(mid), y = net.cy + r * Math.sin(mid);
    const text = mod.label.length > 26 ? `${mod.label.slice(0, 24)}…` : mod.label;
    captionLayer.append(svgEl("text", { class: "module-caption", x: x.toFixed(1),
      y: (y + 3.5).toFixed(1), "text-anchor": Math.cos(mid) >= 0 ? "start" : "end",
      fill: apol1ModuleColour(mod.id), opacity: focus ? 0.25 : 1 }, text));
  }
  svg.append(captionLayer);
  return el("div", { class: "chart-box network-box" }, svg);
}

function apol1Header(key, extra) {
  const active = apol1Filter.sort === key;
  const dir = active ? apol1Filter.dir : "desc";
  return el("th", {
    class: `num sortable${active ? " sorted" : ""}`,
    "aria-sort": active ? (dir === "desc" ? "descending" : "ascending") : "none",
    role: "columnheader", tabindex: "0",
    title: extra,
    onclick: () => apol1Sort(key),
    onkeydown: ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); apol1Sort(key); } },
  }, APOL1_SORTS[key].label, el("span", { class: "sort-caret" },
    active ? (dir === "desc" ? "▾" : "▴") : "⇅"));
}

function apol1Sort(key) {
  if (apol1Filter.sort === key) apol1Filter.dir = apol1Filter.dir === "desc" ? "asc" : "desc";
  else { apol1Filter.sort = key; apol1Filter.dir = "desc"; }
  renderApol1Table();
}

/* The share column needs an example to land, and the two genes that make it are
   whichever pair the data currently contrasts hardest: the partner with the
   highest share against the one with the widest lupus literature. Derived
   rather than written down, so it survives a weekly refresh. */
function apol1ShareRationale() {
  const rows = state.apol1.rows;
  if (rows.length < 2) return ["Three counts, and the third is the one that matters."];
  // Not simply the highest share: APOL3 is 2-of-2 and is the very artefact the
  // paragraph below this one warns about, so an example has to clear a
  // denominator worth arguing from before it can carry the point.
  const solid = rows.filter(r => r.lupus_papers >= 5);
  const specific = (solid.length ? solid : rows)
    .reduce((a, b) => (b.share_lb > a.share_lb ? b : a));
  const broad = rows.reduce((a, b) =>
    (b.lupus_papers > a.lupus_papers && b.symbol !== specific.symbol ? b : a));
  return [
    "Three counts, and the third is the one that matters. Raw co-mentions put ",
    el("strong", {}, specific.symbol), ` (${specific.co_lupus}) near `,
    el("strong", {}, broad.symbol), ` (${broad.co_lupus}) — but ` +
    `${specific.co_lupus} of ${specific.symbol}'s ${fmt(specific.lupus_papers)} lupus ` +
    `papers are APOL1 papers, against ${broad.co_lupus} of ${broad.symbol}'s ` +
    `${fmt(broad.lupus_papers)}. ${specific.symbol} is an APOL1 partner; ` +
    `${broad.symbol} co-occurs with everything. Click any column to re-sort. Rows ` +
    "link to the gene's literature page where it has one; hovering one lights it " +
    "up on the map.",
  ];
}

function renderApol1Table() {
  const head = document.getElementById("apol1-thead");
  head.replaceChildren(el("tr", {},
    el("th", { class: "num" }, "#"),
    el("th", {}, "Gene"),
    apol1Header("co_lupus", "Lupus papers that mention this gene and APOL1 together"),
    apol1Header("lupus_papers", "Every lupus paper mentioning this gene, APOL1 or not"),
    apol1Header("share", "The first column as a percentage of the second")));

  const rows = apol1SortedRows();
  const tbody = document.getElementById("apol1-tbody");
  tbody.replaceChildren(...rows.map((r, i) => {
    const known = state.geneBySymbol.has(r.symbol);
    const open = () => known ? showDetail(r.symbol) : null;
    return el("tr", {
      class: `gene-row${known ? "" : " inert"}${apol1Filter.focus === r.symbol ? " is-focus" : ""}`,
      tabindex: known ? "0" : null, role: known ? "button" : null,
      onmouseenter: () => { apol1Filter.hover = r.symbol; renderApol1Map(); },
      onmouseleave: () => { apol1Filter.hover = null; renderApol1Map(); },
      onclick: open,
      onkeydown: ev => { if (known && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); open(); } } },
      el("td", { class: "num muted" }, String(i + 1)),
      el("td", {},
        el("div", { class: "gene-symbol" }, r.symbol),
        el("div", { class: "gene-name" }, r.name || "")),
      el("td", { class: "num" }, fmt(r.co_lupus)),
      el("td", { class: "num muted" }, fmt(r.lupus_papers)),
      el("td", { class: "num" },
        el("div", { class: "score-cell" },
          el("div", { class: "bar-track" },
            el("div", { class: "bar-fill", style: `width:${r.share * 100}%` })),
          el("span", { class: "val" }, `${(r.share * 100).toFixed(1)}%`))));
  }));
}

function renderApol1Map() {
  const host = document.getElementById("apol1-map");
  if (host) host.replaceChildren(apol1Map());
  renderApol1Focus();
}

/* Lives in the controls row, which renderApol1Map does not rebuild, so a click
   on the map would otherwise dim 93 genes with nothing on screen offering a way
   back. */
function renderApol1Focus() {
  const host = document.getElementById("apol1-focus");
  if (!host) return;
  host.replaceChildren(apol1Filter.focus
    ? el("button", { class: "legend-btn active",
        onclick: () => { apol1Filter.focus = null; renderApol1Body(); } },
        `Clear focus: ${apol1Filter.focus} ✕`)
    : el("span", { class: "count" }, "Click a gene to isolate it"));
}

function renderApol1Body() {
  renderApol1Map();
  renderApol1Table();
}

function renderApol1View() {
  const view = document.getElementById("view-apol1");
  const d = state.apol1;
  const net = d.network;
  const innerCount = net.nodes.filter(n => n.ring === "lupus").length;
  const outerCount = net.nodes.filter(n => n.ring === "apol1").length;
  const check = (key, label, title) => {
    const box = el("input", { type: "checkbox",
      onchange: e => { apol1Filter[key] = e.target.checked; renderApol1Body(); } });
    box.checked = apol1Filter[key];
    return el("label", { class: "check", title }, box, label);
  };

  view.replaceChildren(
    el("div", { class: "card intro-card" },
      el("h2", {}, "APOL1 in lupus"),
      el("p", {},
        "APOL1 carries two coding variants, ", el("strong", {}, "G1 and G2"),
        ", that arose under selection for resistance to trypanosomes and now, in two " +
        "copies, drive progression to kidney failure in people of recent African " +
        "ancestry. Lupus nephritis is one of the diseases they act on. ",
        el("strong", {}, "Every other tab on this site is structurally incapable of " +
        "showing you that."), " APOL1 has " + fmt(d.lupus_articles) + " papers in the " +
        "lupus corpus, which puts it far outside the top-300 sets the leaderboard and " +
        "the co-mention map are built on; its Open Targets association with SLE is 0.06; " +
        "and its lupus papers are spread evenly across 2012–2026, so it fails the " +
        "concentration test the Emerging tab selects on. It is here because the biology " +
        "is real, not because it scored well."),
      el("p", { class: "sub" },
        "The table below is built only from lupus papers. The map is not, and cannot " +
        "be: of the " + fmt(d.lupus_articles) + " lupus papers PubTator tags with APOL1, " +
        "28 name APOL1 and no other gene, which leaves 24 partners, 20 of them seen " +
        "once, and one partner-partner edge above weight 1. A graph on that is a " +
        "picture of two abstracts. So the map runs on the whole APOL1 literature — " +
        fmt(d.corpus_articles) + " papers — and splits it into two rings.")),

    el("div", { class: "kpi-row" },
      statTile("APOL1 papers", fmt(d.tagged_articles),
        `PubTator-tagged, of ${fmt(d.corpus_articles)} fetched`),
      statTile("Inside the lupus corpus", fmt(d.lupus_articles),
        `${((d.lupus_articles / d.tagged_articles) * 100).toFixed(1)}% of the APOL1 literature`),
      statTile("Lupus-linked partners", fmt(innerCount),
        `of ${fmt(d.partners_total)} genes APOL1 is ever co-mentioned with`),
      statTile("On the outer ring", fmt(outerCount),
        `${fmt(d.outer_min_co)}+ APOL1 papers, no lupus paper yet`)),

    el("div", { class: "card" },
      el("h2", {}, "Genes the lupus literature names alongside APOL1"),
      el("p", { class: "sub" }, ...apol1ShareRationale()),
      el("p", { class: "sub" },
        el("strong", {}, "Small denominators."), " A share of 100% here can mean " +
        "“the only lupus paper naming this gene also named APOL1” — APOL3 " +
        "and APOL4 are exactly that, and they are neighbouring genes on the same locus " +
        "picked up by one re-sequencing paper. Ties break on the lower bound of a 95% " +
        "confidence interval on the share, so 2-of-2 cannot outrank 4-of-7, but the " +
        "displayed number is the raw one. Read the denominator."),
      el("div", { class: "table-scroll" },
        el("table", { class: "data apol1-table" },
          el("thead", { id: "apol1-thead" }),
          el("tbody", { id: "apol1-tbody" })))),

    el("div", { class: "card" },
      el("h2", {}, "Two rings"),
      el("p", { class: "sub" },
        "APOL1 at the centre. ", el("strong", {}, "Inner ring: "),
        "the " + fmt(innerCount) + " genes a lupus paper has already co-mentioned with " +
        "it. ", el("strong", {}, "Outer ring: "), "the " + fmt(outerCount) +
        " strongest partners from the wider APOL1 literature that no lupus paper has — " +
        "drawn hollow, because the connection is established elsewhere and untested " +
        "here. Each wedge is a community found from the edges and named by g:Profiler, " +
        "spanning both rings, so an empty inner arc inside a crowded outer wedge is a " +
        "reading list rather than a decoration."),
      el("p", { class: "sub" },
        "Structure comes from the whole APOL1 corpus but the weighting stays anchored " +
        "to lupus: a co-mention in a lupus paper counts for " + d.lupus_weight +
        " ordinary ones, both when the pipeline chooses which of the " +
        fmt(d.outer_eligible) + " eligible partners make the outer ring and when an " +
        "edge is drawn. Edges with a lupus paper behind them are coloured; " +
        "partner-partner edges are gated at p < " + d.partner_p + " on a hypergeometric " +
        "tail, the same test the co-mention map uses."),
      el("div", { class: "legend" },
        el("span", {}, el("span", { class: "swatch", style: "background:var(--ink)" }), "APOL1"),
        el("span", {}, el("span", { class: "swatch apol1-key-inner" }), "lupus-linked (filled)"),
        el("span", {}, el("span", { class: "swatch apol1-key-outer" }), "APOL1 literature only (hollow)"),
        el("span", {}, el("span", { class: "key", style: "border-top-color:var(--series-2)" }),
          "edge with a lupus paper behind it")),
      el("div", { class: "filter-row" },
        check("showOuter", "Outer ring", "Hide to see the lupus-linked ring alone"),
        check("showSpokes", "Spokes to APOL1", "Every partner's edge to the hub"),
        check("allLabels", "Label every gene", "Off: only the lupus-linked ring is labelled"),
        el("span", { class: "apol1-focus-slot", id: "apol1-focus" })),
      el("div", { id: "apol1-map" }),
      el("p", { class: "sub net-key" },
        "Dot size is how many APOL1 papers mention the gene. Colour is its wedge. " +
        "Hover for the counts behind every edge and node.")),

    d.articles.length
      ? el("div", { class: "card" },
          el("h2", {}, "The lupus papers"),
          el("p", { class: "sub" },
            "All " + fmt(d.articles.length) + " papers in the lupus corpus that PubTator " +
            "tags with APOL1, newest first. This is a small enough literature to read, " +
            "which is the honest way to use everything above it."),
          el("ul", { class: "article-list" },
            ...d.articles.map(a => el("li", {},
              el("a", { href: `https://pubmed.ncbi.nlm.nih.gov/${a.pmid}/`,
                target: "_blank", rel: "noopener" }, a.title || `PMID ${a.pmid}`),
              el("div", { class: "muted" },
                `${a.journal || "—"} · ${a.year || "—"}` +
                (a.genes.length ? ` · also mentions ${a.genes.join(", ")}`
                                : " · no other gene mentioned"))))))
      : null,
  );
  renderApol1Body();
}

/* ---------- view switching ---------- */
function switchView(name, { keepHash } = {}) {
  for (const tab of document.querySelectorAll(".tab")) {
    const active = tab.dataset.view === name;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  }
  for (const v of ["genes", "targets", "emerging", "network", "apol1", "pathways", "compare", "about", "detail"]) {
    document.getElementById(`view-${v}`).hidden = v !== name;
  }
  if (!keepHash) setHash();   // drops #gene= but preserves any custom weighting
  if (name === "genes") renderGenesView();
  if (name === "targets") renderTargetsView();
  if (name === "emerging") renderEmergingView();
  if (name === "network") renderNetworkView();
  if (name === "apol1") renderApol1View();
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
  // Target scoring is a separate pipeline step; the dashboard still works
  // without it, so a missing file hides the tab rather than breaking the page.
  const [targets, emerging, network, apol1] = await Promise.all(
    ["targets", "emerging", "network", "apol1"].map(name => fetch(`data/${name}.json`)
      .then(r => (r.ok ? r.json() : null)).catch(() => null)));
  state.genes = genes.genes;
  state.meta = meta;
  state.pathways = pathways.pathways;
  state.pool = pool.pool;
  for (const g of state.genes) state.geneBySymbol.set(g.symbol, g);
  for (const a of articles.articles) state.articles.set(a.pmid, a);
  for (const t of state.pathways) state.pathwayById.set(t.id, t);

  state.weights = readWeightsFromHash() || { ...meta.weights };
  rescore();

  const targetsTab = document.querySelector('.tab[data-view="targets"]');
  if (targets && targets.targets.length) {
    state.targetMeta = targets;
    state.targets = targets.targets;
    state.targetWeights = readTargetWeightsFromHash() || { ...targets.pillar_weights };
    rescoreTargets();
  } else if (targetsTab) {
    targetsTab.remove();
  }

  const emergingTab = document.querySelector('.tab[data-view="emerging"]');
  if (emerging && emerging.genes.length) {
    state.emerging = emerging.genes;
    state.emergingMeta = emerging;
  } else if (emergingTab) {
    emergingTab.remove();
  }

  const networkTab = document.querySelector('.tab[data-view="network"]');
  if (network && network.nodes.length) {
    state.network = network;
    for (const n of network.nodes) state.networkBySymbol.set(n.symbol, n);
  } else if (networkTab) {
    networkTab.remove();
  }

  const apol1Tab = document.querySelector('.tab[data-view="apol1"]');
  if (apol1 && apol1.rows.length) {
    state.apol1 = apol1;
  } else if (apol1Tab) {
    apol1Tab.remove();
  }

  document.getElementById("loading").remove();
  document.getElementById("provenance").textContent =
    `Last updated ${meta.updated} · ${fmt(meta.corpus_articles)} articles · query: ${meta.query}`;
  renderKPIs();
  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => switchView(tab.dataset.view));
  }
  const params = new URLSearchParams(location.hash.slice(1));
  const hashGene = params.get("gene");
  const hashTarget = params.get("target");
  const hashEmerging = params.get("emerging");
  const hashNetwork = params.get("network");
  if (hashTarget && state.targetRanked.some(t => t.symbol === hashTarget)) showTargetDetail(hashTarget);
  else if (hashNetwork && state.network
           && (state.networkBySymbol.has(hashNetwork) || state.network.neighbours[hashNetwork]))
    showNetworkDetail(hashNetwork);
  else if (hashEmerging && state.emerging.some(g => g.symbol === hashEmerging)) showEmergingDetail(hashEmerging);
  else if (hashGene && state.ranked.some(g => g.symbol === hashGene)) showDetail(hashGene);
  else switchView("genes");
}

boot().catch(err => {
  document.getElementById("loading").textContent =
    `Could not load data (${err.message}). Run the pipeline first: python3 pipeline/run_all.py`;
});
