# Lupus Gene Tracker

A bioinformatics dashboard that ranks genes by how prominently they feature in
systemic lupus erythematosus (SLE) research, with pathway enrichment
(GO-BP / KEGG / Reactome) and per-gene article lists linking back to PubMed.

Fully static: a Python pipeline aggregates public data into JSON, and the
dashboard is plain HTML/JS — free to host on GitHub Pages, with a weekly
GitHub Actions refresh.

## How it works

```
PubMed E-utilities ──> lupus PMIDs (~114k articles)
PubTator 3        ──> gene mentions per article (Entrez-normalized)
Open Targets      ──> curated SLE association scores (MONDO_0007915)
g:Profiler        ──> GO-BP / KEGG / Reactome enrichment of top genes
        │
        ▼
data/genes.json · articles.json · pathways.json · meta.json
        │
        ▼
index.html + app.js  (static dashboard)
```

**Combined score** (0–100) per gene = `0.4 · log-scaled mention count +
0.3 · log-scaled recent-5-year mentions + 0.3 · Open Targets association`,
each component normalized to 0–1. Mouse/rat homolog mentions are merged into
the human gene by symbol. Genes are flagged **rising** when their recent-5-year
share of papers is ≥ 1.5× the corpus-wide share, and **genetic** when the Open
Targets genetic-association component is ≥ 0.2.

## Running the pipeline

Requires Python 3.8+ and `requests`. The full first run fetches ~114k articles
from PubTator (~30–45 min); it is resumable, and later runs only fetch new
articles.

```bash
python3 pipeline/run_all.py
```

Individual steps (in `pipeline/`): `fetch_pmids.py` → `fetch_pubtator.py` →
`fetch_opentargets.py` → `build_data.py` → `enrich_pathways.py` →
`build_data.py` (second pass folds enrichment in).

## Viewing locally

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>. (A server is needed — the page fetches
`data/*.json`, which `file://` blocks.)

## Free hosting on GitHub Pages

1. Push this repo to GitHub.
2. Settings → Pages → deploy from branch `main`, root folder.
3. The site is live at `https://<user>.github.io/<repo>/`.
4. The included workflow (`.github/workflows/refresh-data.yml`) re-runs the
   pipeline every Monday and commits fresh `data/` files. The `cache/`
   directory is kept in the Actions cache so weekly runs only fetch new
   articles.

## Data sources & citations

- [PubMed / E-utilities](https://www.ncbi.nlm.nih.gov/books/NBK25501/) — corpus search
- [PubTator 3](https://www.ncbi.nlm.nih.gov/research/pubtator3/) — gene named-entity annotations
- [Open Targets Platform](https://platform.opentargets.org/) — SLE gene–disease associations
- [g:Profiler](https://biit.cs.ut.ee/gprofiler/gost) — functional enrichment (GO-BP, KEGG, Reactome)

Research aid only — not medical advice.
