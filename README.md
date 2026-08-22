<h1>
  <img src="logo-wordmark.svg" alt="Lupus Gene Explorer" width="440">
</h1>

<strong><a href="https://eastmanmd.github.io/LupusExplorer/">View the live site →</a></strong>

A dashboard that tracks which genes the systemic lupus erythematosus (SLE)
research literature is actually talking about. It ranks genes by a combined
literature + evidence score, shows publication trends over time, maps the top
genes onto biological pathways (GO-BP, KEGG, Reactome), and links every gene to
the PubMed articles that mention it. Data refreshes weekly from PubMed,
PubTator 3, Open Targets, and g:Profiler.

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

- **▲ surging** (≥ 1.5×) — TYK2 is 2.7×, CD19 is 3.0×
- **steady** (0.7–1.5×)
- **▼ declining** (≤ 0.7×) — PTPN22 is 0.43× and peaked in 2005; STAT4 is
  0.70× and peaked in 2010

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
