"""Aggregate cached mentions + Open Targets + enrichment into dashboard JSON.

Outputs:
  data/genes.json     ranked genes with score components and per-year counts
  data/articles.json  metadata for each top gene's most recent articles
  data/pathways.json  enriched GO-BP / KEGG / Reactome terms
  data/meta.json      corpus stats and provenance

Run once (writes genes.json with empty pathways), then enrich_pathways.py,
then this again to fold enrichment in — run_all.py does the sequencing.
"""
import datetime
import json
import math
import os
import time
from collections import defaultdict

import requests

import config

HUMAN_TAXID = 9606
MERGE_TAXIDS = {9606, 10090, 10116}  # human, mouse, rat: merge homologs by symbol


def merge_homologs(candidates, info):
    """Entrez id -> pmids, collapsed to {SYMBOL: {pmids, human entrez id}}.

    PubTator annotates the mouse and rat genes in a paper alongside the human
    ones, and a lupus paper about Tlr7 is a lupus paper about TLR7. Groups with
    no human member are dropped: they are plants, microbes and other-species
    annotations that are not lupus genes.

    Shared by build_data, build_emerging and build_network so all three see the
    same genes with the same paper sets.
    """
    groups = {}
    for gid, pmids in candidates.items():
        gi = info.get(gid) or {}
        symbol, taxid = gi.get("symbol"), gi.get("taxid")
        if not symbol or taxid not in MERGE_TAXIDS:
            continue
        group = groups.setdefault(symbol.upper(), {"pmids": set(), "human": None})
        group["pmids"].update(pmids)
        if taxid == HUMAN_TAXID and group["human"] is None:
            group["human"] = gid
    return {k: g for k, g in groups.items() if g["human"] is not None}


def load_mentions():
    articles = {}
    gene_articles = defaultdict(list)  # entrez id -> [pmid]
    with open(config.MENTIONS_FILE) as f:
        for line in f:
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            pmid = rec.get("pmid")
            if not pmid or rec.get("missing") or pmid in articles:
                continue
            articles[pmid] = {
                "pmid": pmid,
                "year": rec.get("year"),
                "journal": rec.get("journal", ""),
                "title": rec.get("title", ""),
            }
            for gid in rec.get("genes", []):
                gene_articles[gid].append(pmid)
    return articles, gene_articles


def fetch_gene_info(gene_ids):
    """Entrez id -> {symbol, name, taxid}, cached across runs."""
    cache = {}
    if os.path.exists(config.GENE_INFO_FILE):
        with open(config.GENE_INFO_FILE) as f:
            cache = json.load(f)
    todo = [g for g in gene_ids if g not in cache]
    print(f"Gene info: {len(gene_ids)} needed, {len(todo)} to fetch")
    session = requests.Session()
    for i in range(0, len(todo), 300):
        batch = todo[i : i + 300]
        for attempt in range(5):
            try:
                r = session.post(
                    f"{config.EUTILS_BASE}/esummary.fcgi",
                    data={"db": "gene", "id": ",".join(batch), "retmode": "json"},
                    timeout=120,
                )
                r.raise_for_status()
                result = r.json().get("result", {})
                break
            except Exception as e:
                print(f"  retry {attempt + 1}: {e}")
                time.sleep(2 ** attempt)
        else:
            raise RuntimeError("esummary failed")
        for uid in result.get("uids", []):
            info = result[uid]
            cache[uid] = {
                "symbol": info.get("name", ""),
                "name": info.get("description", ""),
                "taxid": info.get("organism", {}).get("taxid"),
            }
        for uid in batch:  # dead/withdrawn ids: cache a stub
            cache.setdefault(uid, {"symbol": "", "name": "", "taxid": None})
        print(f"  {min(i + 300, len(todo))}/{len(todo)}")
        time.sleep(config.EUTILS_DELAY)
    with open(config.GENE_INFO_FILE, "w") as f:
        json.dump(cache, f)
    return cache


def classify_trend(total, velocity):
    """Surging / steady / declining, from the 5-year-over-5-year ratio.

    Genes with very little literature stay 'steady' — a jump from 1 paper to 3
    is noise, not a trend.
    """
    if total < 15:
        return "steady"
    if velocity >= 1.5:
        return "surging"
    if velocity <= 0.7:
        return "declining"
    return "steady"


def main():
    articles, gene_articles = load_mentions()
    years = [a["year"] for a in articles.values() if a["year"]]
    # Publishers pre-date some epub articles a year or two ahead; clamp so the
    # chart axes end at the actual current year.
    today = datetime.date.today()
    max_year = min(max(years), today.year)
    # Windowed statistics have to compare equal spans of time. The current
    # calendar year is only partly elapsed, so counting it as "recent" divides
    # a short window by a full one and understates every gene's velocity —
    # enough to push genes across the surging/declining thresholds. Charts
    # still plot through max_year; the statistics stop at the last year that
    # actually finished.
    complete_year = max_year - 1 if max_year >= today.year else max_year
    recent_cutoff = complete_year - config.RECENT_YEARS + 1
    corpus_recent_share = sum(1 for y in years
                              if recent_cutoff <= y <= complete_year) / len(years)
    print(f"{len(articles)} articles, {len(gene_articles)} distinct gene ids, "
          f"years up to {max_year} (statistics through {complete_year})")

    candidates = {g: p for g, p in gene_articles.items()
                  if len(p) >= config.MIN_PAPERS_FOR_CANDIDATE}
    print(f"{len(candidates)} candidate genes with >= "
          f"{config.MIN_PAPERS_FOR_CANDIDATE} papers")
    info = fetch_gene_info(sorted(candidates))

    groups = merge_homologs(candidates, info)

    with open(config.OPENTARGETS_FILE) as f:
        opentargets = json.load(f)
    drugs = {}
    if os.path.exists(config.DRUGS_FILE):
        with open(config.DRUGS_FILE) as f:
            drugs = json.load(f)
    else:
        print("NOTE: no drug cache yet; run fetch_drugs.py for clinical badges")

    genes = []
    for key, group in groups.items():
        pmid_set = group["pmids"]
        year_counts = defaultdict(int)
        for pmid in pmid_set:
            y = articles[pmid]["year"]
            if y:
                year_counts[y] += 1
        total = len(pmid_set)
        recent = sum(c for y, c in year_counts.items()
                     if recent_cutoff <= y <= complete_year)
        # Velocity: share of papers in the last 5 years vs the 5 years before.
        # >1 means attention is accelerating, <1 means the gene is past its peak.
        # Both windows end on a completed year so the ratio is like-for-like.
        prior_start = recent_cutoff - config.RECENT_YEARS
        prior = sum(c for y, c in year_counts.items()
                    if prior_start <= y < recent_cutoff)
        velocity = (recent + 1) / (prior + 1)
        # Later year wins a tie: `year_counts` is built by iterating a set, so
        # bare max() picks whichever tied year happened to be inserted first and
        # the sparkline's peak marker moves between otherwise identical runs.
        peak_year = max(year_counts, key=lambda y: (year_counts[y], y)) if year_counts else None
        human_gi = info[group["human"]]
        ot = opentargets.get(human_gi["symbol"], {})
        drug = drugs.get(human_gi["symbol"], {})
        genes.append({
            "symbol": human_gi["symbol"],
            "name": human_gi["name"],
            "entrez": group["human"],
            "papers": total,
            "recent_papers": recent,
            "year_counts": dict(sorted(year_counts.items())),
            # PMID descending as the tie-break within a year: `pmid_set` is a
            # set, so without it the sample of same-year articles reshuffles
            # every run and the weekly refresh commits churn that means nothing.
            "pmids_by_year": sorted(
                pmid_set, key=lambda p: (articles[p]["year"] or 0, p), reverse=True),
            "ot_score": ot.get("score", 0.0),
            "ot_genetic": ot.get("datatypes", {}).get("genetic_association", 0.0),
            "ot_datatypes": {k: round(v, 3) for k, v in ot.get("datatypes", {}).items()},
            "ot_datasources": {k: round(v, 3) for k, v in ot.get("datasources", {}).items()},
            "rising": (total >= 20 and
                       recent / total > 1.5 * corpus_recent_share),
            "velocity": round(velocity, 2),
            "prior_papers": prior,
            "peak_year": peak_year,
            "trend": classify_trend(total, velocity),
            "drug_stage": drug.get("top_stage"),
            "drugs": drug.get("drugs", []),
        })

    max_log = max(math.log1p(g["papers"]) for g in genes)
    max_recent_log = max(math.log1p(g["recent_papers"]) for g in genes)
    w = config.SCORE_WEIGHTS
    for g in genes:
        g["mention_norm"] = round(math.log1p(g["papers"]) / max_log, 4)
        g["recency_norm"] = round(math.log1p(g["recent_papers"]) / max_recent_log, 4)
        g["score"] = round(100 * (w["mentions"] * g["mention_norm"]
                                  + w["recency"] * g["recency_norm"]
                                  + w["opentargets"] * g["ot_score"]), 1)
    genes.sort(key=lambda g: -g["score"])
    top = genes[: config.TOP_N_GENES]
    for rank, g in enumerate(top, 1):
        g["rank"] = rank

    # Slim scoring pool: every ranked gene with just the three score components,
    # so the dashboard's weight sliders can re-rank across the whole set rather
    # than only the shipped top N. Genes outside the top N have no detail payload.
    pool = [{
        "symbol": g["symbol"],
        "name": g["name"],
        "entrez": g["entrez"],
        "papers": g["papers"],
        "recent_papers": g["recent_papers"],
        "m": g["mention_norm"],
        "r": g["recency_norm"],
        "o": round(g["ot_score"], 4),
        "rank": g.get("rank"),        # default-weight rank; null outside the top N
        "trend": g["trend"],
        "velocity": g["velocity"],
        "drug_stage": g["drug_stage"],
    } for g in genes]

    # Pathways: fold in enrichment results if present
    pathways = []
    top_symbols = {g["symbol"] for g in top}
    gene_pathways = defaultdict(list)
    if os.path.exists(config.ENRICHMENT_FILE):
        with open(config.ENRICHMENT_FILE) as f:
            for term in json.load(f):
                term["genes"] = [s for s in term["genes"] if s in top_symbols]
                pathways.append(term)
                for s in term["genes"]:
                    gene_pathways[s].append(term["id"])
    else:
        print("NOTE: no enrichment cache yet; genes.json will have empty pathways")

    # Articles payload: most recent N per top gene
    keep_articles = {}
    for g in top:
        kept = g["pmids_by_year"][: config.ARTICLES_PER_GENE]
        g["article_pmids"] = kept
        g["pathways"] = gene_pathways.get(g["symbol"], [])
        del g["pmids_by_year"]
        for pmid in kept:
            keep_articles.setdefault(pmid, dict(articles[pmid], genes=[]))
            keep_articles[pmid]["genes"].append(g["symbol"])

    os.makedirs(config.DATA_DIR, exist_ok=True)
    with open(os.path.join(config.DATA_DIR, "genes.json"), "w") as f:
        json.dump({"genes": top}, f)
    with open(os.path.join(config.DATA_DIR, "pool.json"), "w") as f:
        json.dump({"pool": pool}, f)
    with open(os.path.join(config.DATA_DIR, "articles.json"), "w") as f:
        json.dump({"articles": sorted(keep_articles.values(),
                                      key=lambda a: -(a["year"] or 0))}, f)
    with open(os.path.join(config.DATA_DIR, "pathways.json"), "w") as f:
        json.dump({"pathways": pathways}, f)
    corpus_year_counts = defaultdict(int)
    for a in articles.values():
        if a["year"] and 1950 <= a["year"] <= max_year:
            corpus_year_counts[a["year"]] += 1
    with open(os.path.join(config.DATA_DIR, "meta.json"), "w") as f:
        json.dump({
            "updated": datetime.date.today().isoformat(),
            "corpus_year_counts": dict(sorted(corpus_year_counts.items())),
            "query": config.PUBMED_QUERY,
            "corpus_articles": len(articles),
            "genes_ranked": len(genes),
            "genes_shown": len(top),
            "max_year": max_year,
            "complete_year": complete_year,
            "recent_cutoff": recent_cutoff,
            "weights": config.SCORE_WEIGHTS,
        }, f)
    print(f"Wrote {len(top)} genes, {len(keep_articles)} articles, "
          f"{len(pathways)} pathways to {config.DATA_DIR}")
    print("Top 15:", ", ".join(g["symbol"] for g in top[:15]))


if __name__ == "__main__":
    main()
