"""Genes the lupus field has only recently started publishing on.

The leaderboard score is 0.4*log(papers) + 0.3*log(recent) + 0.3*Open Targets.
Two of those three terms grow with accumulated attention, and the Open Targets
association score is itself partly literature-derived, so it lags by years. A
gene with eighteen papers, all of them since 2020, cannot rank however fast it
is moving. No slider setting fixes that — it needs a different question.

The question here: given that a share `p0` of the whole lupus corpus was
published in the recent window, how improbable is it that `k` of a gene's `n`
papers landed there?

    p = P(X >= k | X ~ Binomial(n, p0))

That is a real probability, and it prices in the fact that the corpus itself
roughly doubled over the period, which a raw before/after ratio does not.

It is used as the *gate*, not the ranking. Statistical power grows with n, so
sorting on it puts the genes with the most papers on top — TYK2's 66-of-107
beats NELL1's 18-of-19 on significance while being far less of a newcomer, and
"already famous" is exactly what this tab exists to exclude. Genes are ranked
instead on the effect size, shrunk for sample size: the Wilson score lower
bound on the recent share. That rewards a high share, discounts it honestly
when it rests on five papers, and does not keep climbing just because a gene is
well published.

    emergence = 100 * wilson_lower(k, n)

Genes are then placed on two axes:

  novelty to lupus   share of the gene's lupus papers inside the recent window
  maturity elsewhere its total PubMed footprint, from cache/specificity.json

which quarter the set into four readings: proteins that are well understood in
general and brand new to lupus (the read-across candidates), genes that are new
everywhere (frontier biology), and the two lower bands where lupus interest is
accelerating on top of an existing base.

Runs twice, like build_data/enrich_pathways: pass one writes the candidate list
with no maturity axis, fetch_specificity.py resolves each candidate's PubMed
footprint and corroboration count, pass two folds those in.
"""
import datetime
import json
import math
import os
from collections import defaultdict

import config
from build_data import fetch_gene_info, load_mentions, merge_homologs

QUADRANTS = {
    # (mature elsewhere, novel to lupus) -> id, label, blurb
    (True, True): ("borrowed", "Borrowed biology",
                   "Well studied elsewhere in biology, essentially new to lupus. "
                   "The mechanism and often the tool compounds already exist — "
                   "what is new is someone pointing them at this disease."),
    (False, True): ("frontier", "Frontier",
                    "Thinly studied anywhere, and what little lupus literature "
                    "exists is nearly all recent. Highest risk, least crowded."),
    (True, False): ("accelerating", "Accelerating classics",
                    "Familiar proteins with a real pre-existing lupus literature "
                    "that the field has returned to sharply in the last five years."),
    (False, False): ("climbers", "Quiet climbers",
                     "Small literatures in general, with lupus interest building "
                     "steadily on top of an earlier base."),
}


def log_binom_sf(n, k, p):
    """log P(X >= k) for X ~ Binomial(n, p), summed in log space.

    n here is capped at EMERGING_MAX_PAPERS, so the exact sum is cheap and there
    is no reason to reach for a normal approximation that would misprice exactly
    the small-n genes this module exists to rank.
    """
    if k <= 0:
        return 0.0
    if k > n:
        return -math.inf
    log_p, log_q = math.log(p), math.log1p(-p)
    terms = [
        math.lgamma(n + 1) - math.lgamma(i + 1) - math.lgamma(n - i + 1)
        + i * log_p + (n - i) * log_q
        for i in range(k, n + 1)
    ]
    top = max(terms)
    return top + math.log(sum(math.exp(t - top) for t in terms))


def wilson_lower(k, n, z=1.96):
    """Lower bound of the Wilson score interval for k successes in n trials.

    The ranking has to compare 18-of-19 against 66-of-107 against 5-of-5. A raw
    share treats all three as equally certain and floats every 5-of-5 fluke to
    the top; the Wilson bound asks what share the data will actually support,
    so a small sample is pulled down in proportion to how little it says.
    """
    if n <= 0:
        return 0.0
    phat = k / n
    denom = 1 + z * z / n
    centre = phat + z * z / (2 * n)
    margin = z * math.sqrt(phat * (1 - phat) / n + z * z / (4 * n * n))
    return max(0.0, (centre - margin) / denom)


def main():
    articles, gene_articles = load_mentions()
    years = [a["year"] for a in articles.values() if a["year"]]
    today = datetime.date.today()
    max_year = min(max(years), today.year)
    complete_year = max_year - 1 if max_year >= today.year else max_year
    recent_cutoff = complete_year - config.RECENT_YEARS + 1

    # Baseline: the share of the whole corpus published in the recent window.
    # Every count below stops at complete_year, so the gene numerator and this
    # denominator cover the same span — the current year is only part elapsed
    # and would drag every gene's share down together.
    scored_years = [y for y in years if y <= complete_year]
    p0 = sum(1 for y in scored_years
             if y >= recent_cutoff) / len(scored_years)
    print(f"Corpus recent share ({recent_cutoff}-{complete_year}): {p0:.4f}")

    candidates = {g: p for g, p in gene_articles.items()
                  if len(p) >= config.MIN_PAPERS_FOR_CANDIDATE}
    info = fetch_gene_info(sorted(candidates))

    groups = merge_homologs(candidates, info)

    with open(config.OPENTARGETS_FILE) as f:
        opentargets = json.load(f)
    drugs = {}
    if os.path.exists(config.DRUGS_FILE):
        with open(config.DRUGS_FILE) as f:
            drugs = json.load(f)
    specificity = {}
    if os.path.exists(config.SPECIFICITY_FILE):
        with open(config.SPECIFICITY_FILE) as f:
            specificity = {k: v for k, v in json.load(f).items() if isinstance(v, dict)}
    lit_rank = {}
    pool_path = os.path.join(config.DATA_DIR, "pool.json")
    if os.path.exists(pool_path):
        with open(pool_path) as f:
            lit_rank = {g["symbol"]: g["rank"] for g in json.load(f)["pool"]}

    ln_threshold = math.log(config.EMERGING_P_THRESHOLD)
    genes, excluded = [], []
    for symbol, group in groups.items():
        # Charts plot every year; the statistics stop at the last finished one,
        # so `papers` is deliberately not the sum of `year_counts`.
        year_counts = defaultdict(int)
        for pmid in group["pmids"]:
            y = articles[pmid]["year"]
            if y and y <= max_year:
                year_counts[y] += 1
        total = sum(c for y, c in year_counts.items() if y <= complete_year)
        recent = sum(c for y, c in year_counts.items()
                     if recent_cutoff <= y <= complete_year)
        if not (config.MIN_PAPERS_FOR_CANDIDATE <= total <= config.EMERGING_MAX_PAPERS):
            continue
        if recent < config.EMERGING_MIN_RECENT:
            continue
        log_p = log_binom_sf(total, recent, p0)
        if log_p >= ln_threshold:
            continue

        human = info[group["human"]]
        collision = config.ALIAS_COLLISIONS.get(human["symbol"].upper())
        if collision:
            excluded.append({"symbol": human["symbol"], "reason": collision})
            continue

        # Recent articles, newest first — the point of the tab is being able to
        # read what the new papers actually are.
        # PMID descending as the tie-break within a year: `pmids` is a set, so
        # without it the sample of same-year papers reshuffles every run and the
        # weekly refresh commits churn that means nothing.
        recent_pmids = sorted(
            (p for p in group["pmids"]
             if (articles[p]["year"] or 0) >= recent_cutoff),
            key=lambda p: (articles[p]["year"] or 0, p), reverse=True,
        )[: config.EMERGING_ARTICLES_PER_GENE]

        spec = specificity.get(human["symbol"], {})
        pubmed_total = spec.get("total")
        pubmed_lupus = spec.get("lupus")
        ot = opentargets.get(human["symbol"], {})
        drug = drugs.get(human["symbol"], {})
        genes.append({
            "symbol": human["symbol"],
            "name": human["name"],
            "entrez": group["human"],
            "papers": total,
            "recent_papers": recent,
            "debut": min(year_counts),
            "year_counts": dict(sorted(year_counts.items())),
            "recent_share": round(recent / total, 4),
            "emergence": round(100 * wilson_lower(recent, total), 1),
            "surprise": round(-log_p / math.log(10), 2),
            "pubmed_total": pubmed_total,
            "pubmed_lupus": pubmed_lupus,
            "corroboration": (round(pubmed_lupus / total, 2)
                              if pubmed_lupus is not None else None),
            "aliases": spec.get("aliases", []),
            "ot_score": round(ot.get("score", 0.0), 4),
            "drug_stage": drug.get("top_stage"),
            "drugs": drug.get("drugs", []),
            "lit_rank": lit_rank.get(human["symbol"]),
            "articles": [
                {"pmid": p, "year": articles[p]["year"],
                 "journal": articles[p]["journal"], "title": articles[p]["title"]}
                for p in recent_pmids
            ],
        })

    # Quadrants. Genes whose PubMed footprint has not been fetched yet (pass
    # one) get no quadrant rather than a wrong one.
    for g in genes:
        if g["pubmed_total"] is None:
            g["quadrant"] = None
            continue
        mature = g["pubmed_total"] >= config.EMERGING_MATURITY_SPLIT
        novel = g["recent_share"] >= config.EMERGING_NOVELTY_SPLIT
        g["quadrant"] = QUADRANTS[(mature, novel)][0]

    lo, hi = config.EMERGING_CORROBORATION_RANGE
    for g in genes:
        c = g["corroboration"]
        g["unverified"] = c is not None and not (lo <= c <= hi)

    genes.sort(key=lambda g: (-g["emergence"], -g["recent_papers"], g["symbol"]))

    for rank, g in enumerate(genes, 1):
        g["rank"] = rank

    payload = {
        "genes": genes,
        "quadrants": [
            {"id": qid, "label": label, "blurb": blurb, "mature": mature, "novel": novel}
            for (mature, novel), (qid, label, blurb) in QUADRANTS.items()
        ],
        "corpus_recent_share": round(p0, 4),
        "recent_cutoff": recent_cutoff,
        "complete_year": complete_year,
        "max_year": max_year,
        "max_papers": config.EMERGING_MAX_PAPERS,
        "p_threshold": config.EMERGING_P_THRESHOLD,
        "maturity_split": config.EMERGING_MATURITY_SPLIT,
        "novelty_split": config.EMERGING_NOVELTY_SPLIT,
        "corroboration_range": list(config.EMERGING_CORROBORATION_RANGE),
        "excluded": sorted(excluded, key=lambda e: e["symbol"]),
    }
    os.makedirs(config.DATA_DIR, exist_ok=True)
    with open(config.EMERGING_FILE, "w") as f:
        json.dump(payload, f)

    missing = sum(1 for g in genes if g["pubmed_total"] is None)
    counts = defaultdict(int)
    for g in genes:
        counts[g["quadrant"]] += 1
    print(f"Wrote {len(genes)} emerging genes to {config.EMERGING_FILE}")
    print(f"  quadrants: " + ", ".join(f"{k or 'unplaced'}={v}" for k, v in counts.items()))
    if missing:
        print(f"  {missing} without a PubMed footprint yet — run fetch_specificity.py, "
              "then this again")
    if excluded:
        print(f"  {len(excluded)} dropped as known alias collisions: "
              + ", ".join(e["symbol"] for e in excluded))
    print("  Top 15: " + ", ".join(g["symbol"] for g in genes[:15]))


if __name__ == "__main__":
    main()
