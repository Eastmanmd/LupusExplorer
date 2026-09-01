<h1>
  <img src="logo-wordmark.svg" alt="Lupus Gene Explorer" width="440">
</h1>

<strong><a href="https://eastmanmd.github.io/LupusExplorer/">View the live site →</a></strong>

A dashboard that tracks which genes the systemic lupus erythematosus (SLE)
research literature is actually talking about. It ranks genes by a combined
literature + evidence score, shows publication trends over time, maps the top
genes onto biological pathways (GO-BP, KEGG, Reactome), surfaces the genes the
field has only just started publishing on, maps which genes get written about
together, and links every gene to the PubMed articles that mention it. Data
refreshes weekly from PubMed, PubTator 3, Open Targets, and g:Profiler.

## The combined score

Each gene gets a score from 0–100:

> **score = 100 × (0.4 · mentions + 0.3 · recency + 0.3 · Open Targets)**

| Component | What it measures |
|---|---|
| **Mentions** (×0.4) | How many lupus papers ever mention the gene (log-scaled, so IL6's thousands of papers don't drown everything else) |
| **Recency** (×0.3) | How many papers mention it in the last 5 years (log-scaled) — surfaces where the field is moving now |
| **Open Targets** (×0.3) | The curated Open Targets association score between the gene and SLE — independent, expert-curated evidence that keeps pure publication hype in check |

Each component is normalized to 0–1 before weighting, and every gene's detail
page shows its breakdown, so you can always see *why* a gene ranks where it does.

### Adjust the weights yourself

The weights above are only a starting point. **Sliders on the leaderboard
re-rank all 1,505 genes in real time**, so you can ask different questions of
the same data:

- Push **Recency** up to surface newly emergent candidates rather than
  long-established targets.
- Push **Open Targets** up to rank by curated biological evidence rather than
  publication volume — this pulls up the classic SLE genetics hits (TREX1,
  DNASE1L3, BLK, TYK2, PTPN22) and brings in ~110 genes that never appear
  under the default weighting.
- Genes that move show a **▲/▼ rank delta** against the default ranking, and
  ones entering from outside the default top 300 are marked **new**.

Weights are normalized to sum to 100% so scores stay comparable, and the
current weighting is written into the URL — so a particular weighting is a
shareable, citable link (e.g. `…/#w=0.10,0.20,0.70`).

## How the genes were curated

No hand-picked gene list — genes emerge from the literature itself:

1. **Corpus**: every PubMed article matching
   `"lupus erythematosus, systemic"[MeSH] OR lupus[tiab]` (~114,000 articles).
2. **Gene mentions**: PubTator 3's machine-read annotations identify every gene
   mentioned in each title/abstract, normalized to Entrez gene IDs (so "IFN-γ",
   "interferon gamma", and "IFNG" all count as the same gene).
3. **Filtering**: a gene needs mentions in ≥5 papers to be considered; mouse and
   rat homolog mentions (common in lupus mouse-model studies) are merged into
   the corresponding human gene, and non-human-only hits are dropped.
4. **Ranking**: the ~1,500 surviving genes are scored, and the top 300 are
   shown in the dashboard.

## Emerging genes

The combined score is built from how many lupus papers a gene has and how strong
its curated evidence is. Both grow with accumulated attention, and the Open
Targets score is itself partly literature-derived, so it lags by years. A gene
whose entire lupus literature is four years old **cannot rank on the
leaderboard**, however fast it is moving — no slider setting fixes that. The
**Emerging genes** tab selects on the opposite property.

### The gate: is this literature improbably recent?

About 20% of the whole lupus corpus was published in the last five complete
years. So for a gene with `n` lupus papers, `k` of them recent, ask how unlikely
`k` would be if its papers had simply fallen where the corpus fell:

> **p = P(X ≥ k | X ~ Binomial(n, 0.198))**

A gene qualifies at **p < 0.01**, with at most **150 lupus papers** — the point
is the genes the field has not caught up with yet. Using a real probability
prices in the fact that the corpus itself roughly doubled over the period, which
a raw before/after ratio does not.

### The ranking: how new is it, really?

That test is the gate, **not** the sort key. Statistical power grows with sample
size, so ranking on `p` puts the best-published genes on top — TYK2's 66-of-107
beats NELL1's 18-of-19 on significance while being far less of a newcomer, and
"already famous" is exactly what this tab exists to exclude. Genes are ranked on
the effect size instead, shrunk for how few papers it rests on:

> **emergence = 100 × Wilson score lower bound of k/n**

A gene with 18 of 19 papers in the window beats one with 66 of 107, and 5 of 5
does not beat either.

### The 2×2

Each gene is placed on two axes — how recent its lupus literature is, and how
much biology as a whole has studied it (its total PubMed footprint, from the
same alias-expanded query the specificity denominator uses):

| | **Thinly studied elsewhere** (< 1,000 papers) | **Well studied elsewhere** (≥ 1,000 papers) |
|---|---|---|
| **≥ 75% of its lupus papers are recent** | **Frontier** — new everywhere. NELL1, EXT1, SEMA3B, THSD7A, HERC6 | **Borrowed biology** — the mechanism and often the tool compounds already exist; what is new is someone pointing them at lupus. SLC5A2 (SGLT2), GLP1R, GSDMD, SLC7A11 |
| **< 75%** | **Quiet climbers** — small literatures building on an earlier base. IFI44L, IFIT3, IFI27, DNASE1L3 | **Accelerating classics** — familiar proteins the field has returned to sharply. CGAS, TYK2, JAK1, CD163 |

Today that is 27 / 35 / 38 / 146 genes. The top of the list is the membranous
nephropathy antigen wave (EXT1, EXT2, NELL1, SEMA3B, THSD7A — all first
described from 2019 on), the ferroptosis and pyroptosis genes (SLC7A11, GPX4,
GSDMD), and the metabolic repurposing story (SLC5A2, GLP1R).

This is a map of where attention is moving, **not** a ranked list of things to
work on. A gene here has, by construction, thin evidence — that is what makes it
new. The Target opportunities tab asks the second question, and gates hard on
evidence when it does.

### Entity collisions, and why this tab has to check for them

PubTator resolves gene synonyms, which is what makes the mention counts good.
In a literature this small it is also the main failure mode: a gene whose alias
is also a trending acronym silently inherits that acronym's papers, and one
collision is enough to manufacture a top-ranked "emerging gene". Five confirmed
cases are excluded outright, each verified by reading the matched titles:

| Gene | Collides with |
|---|---|
| NR1I3 | **CAR** (constitutive androstane receptor) vs CAR-T cell therapy |
| CXADRP1 | **CAR** (coxsackie-adenovirus receptor) vs CAR-T cell therapy |
| CARTPT | **CART** vs CAR-T cell therapy |
| ABCB6 | **ABC** vs atypical B cells |
| RALGAPA1 | **TULIP1** vs the TULIP-1/TULIP-2 anifrolumab trials |

Left in, NR1I3 and CXADRP1 rank first and second on raw recency.

For everything else the check is computed, not curated: the same alias-expanded
query is run against PubMed's own index *restricted to the lupus corpus*, and
the ratio of that count to PubTator's mention count is shown on every gene. A
ratio outside 0.25–8 flags the gene as **check mentions** — 24 genes today,
including PIK3CA/PIK3CB, whose recent "mentions" are mostly generic PI3K
signalling papers. Flagged genes stay in the table and are drawn faded in the
scatter rather than being silently dropped.

## The co-mention network

Two genes are joined on this map because papers mention them together. That is
the whole of it: **every edge, weight and module comes from the mention data and
nothing else** — no interaction database, no pathway membership, no Open Targets.

That purity extends to who appears. The node set is the **300 genes with the
most lupus papers** (49 or more), *not* the leaderboard's top 300, because the
leaderboard score is 30% Open Targets and would have let a curated database pick
the cast of a map billed as pure co-mention. The two sets differ by 52 genes:
CR1 (168 papers) and FCGR3B are on this map and not the leaderboard; FAM167A and
CRBN are on the leaderboard and not here.

### Two statistics, again

Raw co-mention count is what gets **displayed** — it is the honest, legible
number. It is a bad way to **choose** edges, because the most-published genes
co-occur constantly whatever the biology: IL6 and TNF share 754 papers, second
heaviest in the corpus, and it means nothing. So each pair is:

- **gated** on a hypergeometric tail probability at p < 10⁻⁶ (roughly Bonferroni
  over 45k possible pairs) — *is this more overlap than chance?*
- **selected and ranked** on normalized pointwise mutual information — *how much
  more?* npmi is bounded in −1…1 and its denominator discounts rare pairs, so it
  neither rewards fame like the raw count nor blows up on a 4-of-4 coincidence
  like a bare lift ratio.

Same split as the Emerging tab: significance decides membership, effect size
decides rank.

### Why the threshold you'd reach for first is the wrong one

Sweeping a global minimum co-mention count:

| Threshold | Edges | Genes | Density |
|---|---|---|---|
| ≥5 | 3,167 | 294 | 0.074 |
| ≥10 | 1,568 | 267 | 0.044 |
| ≥20 | 730 | 209 | 0.034 |
| ≥50 | 220 | 103 | 0.042 |

Density stops falling around ≥15 and then rises. Past that point a global
threshold deletes *genes*, not clutter — a third of the map for no readability.
So each gene instead keeps its **strongest k partners** and the union is the
graph: every gene stays, no hub swallows the picture, and k is one slider
(shipped at 6, adjustable down to 1 in the browser). At k=6 that is **927 edges
over 287 genes**; 13 have no partner clearing the gate and are listed separately.

### Modules

Communities come from **Louvain modularity optimisation** over those edges.
Label propagation was tried first and fragmented — 41 communities, 146 genes in
communities of seven or fewer — which leaves a map that is mostly grey. Louvain
gives 13, eleven of them ten genes or larger:

| Module | Genes | Named |
|---|---|---|
| apoptotic signaling | 47 | vs the map |
| chemokine receptors bind chemokines | 34 | vs the map |
| cell adhesion molecule interaction | 33 | vs the map |
| JAK-STAT receptor signaling | 30 | vs the map |
| regulation of lymphocyte activation | 30 | vs the genome |
| initial triggering of complement | 27 | vs the map |
| negative regulation of coagulation | 24 | vs the map |
| toll-like receptor signaling | 16 | vs the map |
| immune receptor signaling (Fcγ receptors) | 16 | vs the genome |
| response to exogenous dsRNA | 16 | vs the map |
| mRNA splicing | 10 | vs the map |
| ACE, REN | 2 | *no term fits* |
| TG, TPO | 2 | *no term fits* |

The names come from g:Profiler in one multi-query request — **annotation laid
over structure co-mention had already produced, never an input to it.** The
background is the map's own 300 genes, not the genome: against a genome
background every module in a lupus gene set enriches for "immune system process"
and the labels say nothing, whereas against the other 299 a module is only named
for what makes it *different from the rest of the board*. A second pass against
the genome supplies a fallback for modules that clear no bar in the first, and
which scope produced a name is shown.

Two filters keep the captions honest. KEGG's `05xxx` (Human Diseases) and
`01xxx` (global maps, antineoplastic drug resistance) blocks are dropped — a
module of MAPK and AKT genes otherwise comes back captioned "Breast cancer" —
and Reactome's disease branch is dropped by name, which is what turned "MyD88
deficiency (TLR2/4)" into "toll-like receptor signaling pathway". And among a
module's surviving terms the caption is the **most specific** term that still
covers half the module, not the smallest p-value, because p-value ordering
rewards enormous parent terms.

The two unnamed modules are the interesting ones. ACE/REN and TG/TPO are
genuinely tight pairs that no ontology term describes, because what they share
is a clinical assay, not a pathway.

### Layout

A seeded spring-and-charge layout, computed in the pipeline and shipped as
coordinates, so the map is identical for every visitor and can be learned. The
browser only draws it. Textbook Fruchterman-Reingold was tried and folds all 287
nodes into one corner — its `d²/k` attraction overwhelms the repulsion in the
first few steps — so edges are rest-length springs, which stop pulling once
satisfied. A weak pull toward each module's centre of mass is layered on top:
without it the peripheral modules come out coherent but the immune core does
not, since those modules genuinely interconnect, and the colours stop meaning
anything. Proximity on the map therefore reflects module membership as well as
co-mention, which is what the captions claim it does.

### Reading it

Dot size is lupus papers, colour is module, a dark ring means an SLE drug or
trial candidate exists against that gene. Hovering isolates a neighbourhood;
clicking opens the full ego network with per-partner co-mention counts, npmi,
and what fraction of the overlap is recent. Edges can be recoloured by age —
CD27–ITGAX and ITGAX–TBX21 (the age-associated B-cell story) are 76% and 69%
recent against a 26% baseline, while CD28–FOXP3 and CD40LG–CTLA4 are 0%.

### Genes too small for the map

709 genes below the 49-paper cutoff still have co-mentions with genes that are
on it, and get an **ego view** even though they never appear in the picture.
This is where the tab meets the Emerging one:

```
NELL1    PLA2R1(17), NCAM1(5)
EXT1     PLA2R1(13), NCAM1(6), C1QA(3)
SEMA3B   PLA2R1(8),  NCAM1(6)
THSD7A   PLA2R1(23), NCAM1(4)
GSDMD    CASP1(9), NLRP3(9), IL1B(6), IL18(4)
```

The Emerging tab finds NELL1, EXT1, SEMA3B and THSD7A independently, by
recency alone. The network says *why they arrived together*: all four sit next
to PLA2R1, the original membranous-nephropathy antigen. Every emerging gene with
a co-mention footprint links straight through to this view.

The absences are informative too. SLC5A2 and GLP1R top the emerging list and
have **no** qualifying co-mention — best partner, two shared papers. They came
into lupus from cardiometabolic medicine rather than from inside lupus
immunology, and an empty neighbourhood says exactly that.

### Co-mention is not interaction

TG and TPO sit together because both are on a thyroid antibody panel. BLK and
FAM167A share a linkage block, not a mechanism. This is a map of how the
*literature* groups genes — part biology, part assay panel, part GWAS locus.
That is what makes it worth having next to the curated Pathways tab, and the
disagreements between the two are the point.

`config.ALIAS_COLLISIONS` applies here as well as to the Emerging tab. Left in,
**CD19–NR1I3 is the single newest strong edge on the whole map** — 33
co-mentions, 88% of them recent — and it is entirely an artefact of PubTator
resolving "CAR" in CAR-T papers onto the constitutive androstane receptor.

## Finding a drug target

The leaderboard ranks **attention**. That is a useful thing to measure, but it
is not the same as opportunity — the genes at the top are largely the ones that
already have drugs. The **Target opportunities** tab scores a different
question: *should someone start a drug programme here?*

Every ranked gene gets a **Target Opportunity Score** built from 16 named
criteria across four pillars:

| Pillar | Weight | The question | Criteria |
|---|---|---|---|
| **Evidence** | 30% | Is the lupus link real, causal, and current? | Genetic association · Overall SLE association · Literature specificity · Research momentum |
| **Tractability** | 30% | Could a molecule actually engage this protein? | Best modality · Chemical matter · Biologic accessibility · Family precedent |
| **Safety** | 20% | Is inhibiting it likely to be tolerated? | LoF tolerance (gnomAD) · Mouse knockout burden (IMPC) · Non-essentiality (DepMap) · Expression focus · Clean safety record |
| **Opportunity** | 20% | Is the space open, and is the pharmacology proven nearby? | Unclaimed space · Cross-indication precedent · Network proximity |

Three things make this more than a re-weighting of the leaderboard:

**Opportunity runs backwards.** A target with an approved lupus drug scores
near zero on this pillar — it is answered, not available. IFNAR1 and TNFSF13B
are triumphs of lupus drug discovery and *bad* answers to "what should we work
on next".

**Evidence is a gate, not just a weight.** A beautifully druggable protein with
no credible link to lupus is not a lupus target, so the whole score is scaled
down (never below 35%) when the evidence pillar is weak. Without this, chemistry
wins: MPL and MIF are eminently druggable and rank in the top 15 on the additive
score alone, on the strength of ~1% of their literature being about lupus.

**Cross-indication precedent is a first-class signal.** A drug that already hits
this target in one of 30 curated immune-mediated indications — rheumatoid
arthritis, Sjögren's, systemic sclerosis, myositis, ANCA vasculitis, ITP,
psoriasis, IBD and others — is proven human pharmacology one indication away.
C1S surfaces this way: sutimlimab is approved in autoimmune hemolytic anemia,
and nothing targets C1S in lupus.

### Reading a gene's page

Click any row for the full breakdown: every criterion with its score, its
weight, the sentence explaining what the number means for *that* gene, and the
database it came from — so "genetic evidence 0.82" expands to *ClinGen, ClinVar,
Genomics England PanelApp, GWAS credible sets, UniProt literature*, and
"literature specificity 0.96" expands to *74 of 266 PubMed papers mentioning
DNASE1L3 (incl. DHP2, DNAS1L3, SLEB16) are lupus papers*.

### Adjust the pillars yourself

As on the leaderboard, four sliders re-rank all 300 genes live and the
weighting is written into the URL. The rankings genuinely diverge:

- **Default** — CCR1, TYK2, BLK, DNASE1L3, TLR7, C1S
- **Opportunity-heavy** — C1S, CCR1, TYK2, CTLA4, TNFSF4, FCGR2A
- **Safety-heavy** — CCL22, CCR1, BLK, DNASE1L3, CD226, IFNA2

Filters are **No SLE programme** / **Repurposing candidates** / **Tractable** /
**Hide safety flags**, and they combine. The most useful single view is the
first two together — 52 genes with proven pharmacology elsewhere and an open
lupus space, led by CCR1, C1S, CTLA4, TNFSF4, C3 and CCR2.

### Literature specificity, and why the denominator is hard

Raw mention counts reward genes famous everywhere: IL6 appears in tens of
thousands of papers across all of biology, so a lupus mention says little about
lupus. The fix is lupus papers ÷ total PubMed papers — but PubTator found the
numerator by resolving synonyms, so a denominator built from the approved symbol
alone is badly wrong. TNFSF13B had *more lupus papers than papers containing the
string "TNFSF13B"*, because the field writes BAFF and BLyS. Entrez aliases go
into the denominator query so both sides count the same way, common English
words are filtered out of the alias list, and genes with fewer than 150 total
papers score neutral rather than spuriously specific.

### Caveats

- Tractability, constraint, essentiality and interaction data come from Open
  Targets' target-prioritisation framework; where a gene is missing a signal it
  scores neutral rather than zero, which flatters sparsely annotated genes.
- The cross-indication list is curated by hand (MONDO's "autoimmune disease"
  branch excludes psoriasis, IBD, systemic sclerosis and myositis, so walking
  the ontology was not an option). It is in `pipeline/config.py` and is meant to
  be edited.
- Network proximity uses IntAct physical interactions only — no directionality,
  so "upstream of a validated target" and "downstream of one" score the same.
- This ranks hypotheses worth a closer look. It is not a substitute for reading
  the biology.

## Pathway analysis

The top-ranked genes are tested for functional enrichment with
**g:Profiler** against three databases — **GO Biological Process**, **KEGG**,
and **Reactome** — using g:SCS-adjusted p-values (threshold 0.05). The
Pathways tab ranks terms by −log₁₀(p), and every term is clickable to reveal
which top genes belong to it; each gene's page shows the reverse mapping.
Top result, reassuringly: complement and coagulation cascades, interferon
signaling, and Toll-like receptor cascades — the core biology of lupus.

## Evidence: where an association comes from

Each gene's row carries a five-cell **evidence strip** (darker = stronger
Open Targets evidence; hover any cell for the score):

| Cell | Evidence class | Sources behind it |
|---|---|---|
| **Genetic** | Variant-level genetic association | GWAS credible sets, gene burden, ClinVar, UniProt variants |
| **Curated genetics** | Expert-curated clinical genetics | Genomics England PanelApp, ClinGen, Orphanet, UniProt literature |
| **RNA** | Differential expression in SLE | Expression Atlas |
| **Drug** | Clinical precedence | A drug against this target reached the clinic for SLE |
| **Model** | Animal-model evidence | IMPC mouse knockout phenotypes |

Each gene's detail page expands the strip into a full **Evidence sources**
panel naming every contributing database and its score, so you can see whether
"genetic evidence" means a genome-wide association signal, a curated ClinVar
variant, or both.

Separately, a **rising ↑** badge marks genes whose share of papers in the last
5 years is ≥ 1.5× the corpus-wide baseline (minimum 20 papers): the literature
is accelerating on them. TLR7 is the poster child — decades of moderate
interest, then a surge after gain-of-function variants were shown to cause
lupus. Evidence-class cells are slow, curated signals; *rising* is fast
literature momentum — genes strong in both are usually the most interesting.

## Literature velocity

Every row carries a **1990–2026 sparkline** with a hollow marker on the gene's
peak year, so you can see at a glance whether a gene is climbing or past its
prime. Beneath it, a **velocity** tag classifies the shape by comparing the
last 5 years against the 5 before:

- **▲ surging** (≥ 1.5×) — TYK2 is 3.7×, CD19 is 2.6×
- **steady** (0.7–1.5×) — STAT4 is 0.97× but peaked back in 2010
- **▼ declining** (≤ 0.7×) — PTPN22 is 0.53× and peaked in 2005

Both windows end on the last **completed** calendar year, not the current one.
The year in progress is only partly published, so counting it as "recent"
would divide a short window by a full one and understate every gene's
velocity — enough to push genes across these thresholds. Charts still plot
through the current year; only the statistics stop at `complete_year`.

This is what separates the GWAS-era classics from today's hot targets: PTPN22
and STAT4 have far more total papers than TYK2, but the field has moved on.
Gene pages show the ratio, the peak year, and the raw counts behind it.

## Druggability and clinical stage

Genes with an SLE drug or trial candidate carry a **clinical-stage badge**
(Approved / Phase 3 / Phase 2 / Phase 1, shaded darker the further along),
sourced from Open Targets / ChEMBL — 51 of the top 300 genes. Hovering names
the drugs; each gene page lists them in full with mechanism and action type:

- **IFNAR1** → Anifrolumab (approved) · **TNFSF13B** → Belimumab (approved)
- **TYK2** → Upadacitinib, Deucravacitinib (Phase 3)
- **CD19** → Obexelimab, Inebilizumab (Phase 2) · **CD40LG** → Dapirolizumab pegol (Phase 3)

**Filter by Surging + In the clinic** to get the genes that are both
accelerating in the literature and already being drugged — 15 genes today,
led by TYK2, CD19, JAK1, CD38, and CLEC4C. That combination is the most
useful view in the tool.

The leaderboard filters are Surging / In the clinic / Rising / Genetic /
RNA evidence, and they combine.

---

Data: [PubMed](https://pubmed.ncbi.nlm.nih.gov/) ·
[PubTator 3](https://www.ncbi.nlm.nih.gov/research/pubtator3/) ·
[Open Targets Platform](https://platform.opentargets.org/) ·
[g:Profiler](https://biit.cs.ut.ee/gprofiler/gost).
Research aid only — not medical advice.
