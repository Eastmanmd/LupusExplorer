"""Recompute the literature score using only papers published on or before a
cutoff year — the "time-travel" arm of the retrospective validation.

Mirrors pipeline/build_data.py's mention/recency scoring exactly (log1p,
max-normalised, homologs merged by uppercased symbol) but truncates the corpus.

READ-ONLY: reads cache/mentions.jsonl and cache/gene_info.json, makes no network
calls, and writes only to analysis/out/.
"""
import json, math, os, sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)

HUMAN_TAXID = 9606
MERGE_TAXIDS = {9606, 10090, 10116}
MIN_PAPERS = 5
RECENT_YEARS = 5


def score_at(cutoff):
    info = json.load(open(os.path.join(ROOT, "cache", "gene_info.json")))
    articles, gene_articles = {}, defaultdict(list)
    with open(os.path.join(ROOT, "cache", "mentions.jsonl")) as f:
        for line in f:
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            pmid, year = rec.get("pmid"), rec.get("year")
            if not pmid or rec.get("missing") or pmid in articles:
                continue
            if year is None or year > cutoff:
                continue          # <-- the time machine
            articles[pmid] = year
            for gid in rec.get("genes", []):
                gene_articles[str(gid)].append(pmid)

    recent_cutoff = cutoff - RECENT_YEARS + 1
    candidates = {g: p for g, p in gene_articles.items() if len(p) >= MIN_PAPERS}
    missing = [g for g in candidates if g not in info]

    groups = {}
    for gid, pmids in candidates.items():
        gi = info.get(gid) or {}
        symbol, taxid = gi.get("symbol"), gi.get("taxid")
        if not symbol or taxid not in MERGE_TAXIDS:
            continue
        grp = groups.setdefault(symbol.upper(), {"members": [], "human": None})
        grp["members"].append(pmids)
        if taxid == HUMAN_TAXID and grp["human"] is None:
            grp["human"] = gid

    genes = []
    for sym, grp in groups.items():
        if grp["human"] is None:
            continue
        pmid_set = set()
        for pmids in grp["members"]:
            pmid_set.update(pmids)
        total = len(pmid_set)
        recent = sum(1 for p in pmid_set if articles[p] >= recent_cutoff)
        prior = sum(1 for p in pmid_set
                    if recent_cutoff - RECENT_YEARS <= articles[p] < recent_cutoff)
        genes.append({"symbol": sym, "papers": total, "recent_papers": recent,
                      "prior_papers": prior,
                      "velocity": round((recent + 1) / (prior + 1), 2)})

    max_log = max(math.log1p(g["papers"]) for g in genes)
    max_rec = max(math.log1p(g["recent_papers"]) for g in genes)
    for g in genes:
        g["mention_norm"] = math.log1p(g["papers"]) / max_log
        g["recency_norm"] = math.log1p(g["recent_papers"]) / max_rec
        # Literature-only score: the 0.4/0.3 mentions/recency split from
        # config.SCORE_WEIGHTS, renormalised to sum to 1 with Open Targets
        # dropped (OT cannot be time-travelled from the current cache).
        g["score"] = round(100 * (4 / 7 * g["mention_norm"]
                                  + 3 / 7 * g["recency_norm"]), 2)
    genes.sort(key=lambda g: -g["score"])
    for i, g in enumerate(genes, 1):
        g["rank"] = i
    return genes, len(articles), missing


if __name__ == "__main__":
    cutoff = int(sys.argv[1]) if len(sys.argv) > 1 else 2015
    genes, n_articles, missing = score_at(cutoff)
    json.dump({"cutoff": cutoff, "n_articles": n_articles, "genes": genes},
              open(os.path.join(OUT, f"scores_{cutoff}.json"), "w"), indent=1)
    print(f"cutoff {cutoff}: {n_articles} articles, {len(genes)} ranked genes"
          + (f", {len(missing)} entrez ids absent from gene_info cache" if missing else ""))
    print(f"\ntop 25 as of {cutoff}:")
    for g in genes[:25]:
        print(f"  {g['rank']:>3}. {g['symbol']:<10} score={g['score']:>5}  "
              f"papers={g['papers']:<5} recent={g['recent_papers']}")
