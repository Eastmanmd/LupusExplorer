# Lupus Gene Tracker

**Live site: <https://eastmanmd.github.io/LupusExplorer/>**

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

## Pathway analysis

The top-ranked genes are tested for functional enrichment with
**g:Profiler** against three databases — **GO Biological Process**, **KEGG**,
and **Reactome** — using g:SCS-adjusted p-values (threshold 0.05). The
Pathways tab ranks terms by −log₁₀(p), and every term is clickable to reveal
which top genes belong to it; each gene's page shows the reverse mapping.
Top result, reassuringly: complement and coagulation cascades, interferon
signaling, and Toll-like receptor cascades — the core biology of lupus.

## Evidence badges

- **genetic** — the gene's Open Targets *genetic association* component for
  SLE is ≥ 0.2, meaning human genetics (GWAS and rare-variant evidence) links
  it to the disease, not just publication volume.
- **rising ↑** — the gene's share of papers in the last 5 years is at least
  1.5× the corpus-wide baseline (minimum 20 papers total): the literature is
  accelerating on this gene. TLR7 is the poster child — decades of moderate
  interest, then a surge after gain-of-function variants were shown to cause
  lupus.

The two badges are deliberately independent: *genetic* is slow, curated
evidence; *rising* is fast, literature-momentum evidence. Genes carrying both
are usually the most interesting.

---

Data: [PubMed](https://pubmed.ncbi.nlm.nih.gov/) ·
[PubTator 3](https://www.ncbi.nlm.nih.gov/research/pubtator3/) ·
[Open Targets Platform](https://platform.opentargets.org/) ·
[g:Profiler](https://biit.cs.ut.ee/gprofiler/gost).
Research aid only — not medical advice.
