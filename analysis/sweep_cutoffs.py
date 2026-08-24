"""Is AUC = 0.84 real, or a 2015 artifact? Re-run the retrospective validation
at every cutoff from 2010 to 2018.

Loads cache/mentions.jsonl ONCE, then rescores per cutoff in memory.
READ-ONLY on cache/ and data/; writes only to analysis/out/.
"""
import json, math, os, random
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)

HUMAN_TAXID, MERGE_TAXIDS = 9606, {9606, 10090, 10116}
MIN_PAPERS, RECENT_YEARS = 5, 5

# PROVISIONAL first-in-SLE clinical entry years, assigned from development
# timelines. These drive every number below and are the single biggest source
# of uncertainty in this analysis -- replace with ClinicalTrials.gov
# first-posted dates before any of it goes in a manuscript.
ENTRY_YEAR = {
    "NR3C1": 1960, "CD40LG": 1999, "MS4A1": 2004, "TNF": 2004, "CD22": 2004,
    "TNFSF13B": 2003, "CD80": 2006, "CD86": 2006, "TNFSF13": 2006,
    "IL6": 2007, "IFNA1": 2008, "IFNA2": 2008, "HSPA8": 2009,
    "IFNAR1": 2010, "SYK": 2010, "IL21": 2012, "IFNG": 2012, "IGHE": 2013,
    "CD28": 2014, "ICOS": 2015, "IL12A": 2015, "IL12B": 2015, "IL23A": 2015,
    "CD19": 2016, "FCGR2B": 2016, "BTK": 2016, "JAK1": 2016, "JAK2": 2016,
    "CLEC4C": 2016, "S1PR1": 2017, "CD40": 2017, "BCL2": 2017, "JAK3": 2017,
    "TYK2": 2018, "IL17A": 2018, "TLR7": 2019, "TLR8": 2019, "CD38": 2019,
    "TNFRSF13C": 2019, "IFNB1": 2021,
}
# Only the best-ranked member of each shared programme counts as a positive.
PROGRAMMES = [["IL12A", "IL12B", "IL23A"], ["JAK1", "JAK2", "JAK3", "TYK2"],
              ["CD19", "FCGR2B"], ["TLR7", "TLR8"], ["CD80", "CD86"],
              ["IFNA1", "IFNA2"], ["TNFSF13B", "TNFSF13"]]


def load():
    info = json.load(open(os.path.join(ROOT, "cache", "gene_info.json")))
    recs = []
    with open(os.path.join(ROOT, "cache", "mentions.jsonl")) as f:
        seen = set()
        for line in f:
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            p, y = r.get("pmid"), r.get("year")
            if not p or r.get("missing") or p in seen or y is None:
                continue
            seen.add(p)
            recs.append((y, [str(g) for g in r.get("genes", [])]))
    return info, recs


def score_at(info, recs, cutoff):
    gene_pmids = defaultdict(set)
    for i, (y, gids) in enumerate(recs):
        if y > cutoff:
            continue
        for g in gids:
            gene_pmids[g].add(i)
    groups = {}
    for gid, pm in gene_pmids.items():
        if len(pm) < MIN_PAPERS:
            continue
        gi = info.get(gid) or {}
        sym, tax = gi.get("symbol"), gi.get("taxid")
        if not sym or tax not in MERGE_TAXIDS:
            continue
        g = groups.setdefault(sym.upper(), {"pm": set(), "human": False})
        g["pm"] |= pm
        g["human"] = g["human"] or tax == HUMAN_TAXID
    rc = cutoff - RECENT_YEARS + 1
    out = []
    for sym, g in groups.items():
        if not g["human"]:
            continue
        tot = len(g["pm"])
        rec = sum(1 for i in g["pm"] if recs[i][0] >= rc)
        out.append({"symbol": sym, "papers": tot, "recent": rec})
    ml = max(math.log1p(g["papers"]) for g in out)
    mr = max(math.log1p(g["recent"]) for g in out)
    for g in out:
        g["score"] = 4/7 * math.log1p(g["papers"])/ml + 3/7 * math.log1p(g["recent"])/mr
    out.sort(key=lambda g: -g["score"])
    return out


def auc(order, pos):
    pi = [i for i, s in enumerate(order) if s in pos]
    np_, nn = len(pi), len(order) - len(pi)
    if not np_ or not nn:
        return None
    beat = sum(len(order)-1-i - sum(1 for j in pi if j > i) for i in pi)
    return beat / (np_ * nn)


def main():
    info, recs = load()
    random.seed(0)
    rows = []
    for cutoff in range(2010, 2019):
        genes = score_at(info, recs, cutoff)
        order_all = [g["symbol"] for g in genes]
        rankable = set(order_all)
        # exclude anything already in the SLE clinic at the cutoff
        order = [s for s in order_all if ENTRY_YEAR.get(s, 9999) > cutoff]
        future = {s for s, y in ENTRY_YEAR.items() if y > cutoff and s in rankable}
        # one positive per programme: keep the best-ranked eligible member
        idx = {s: i for i, s in enumerate(order)}
        for members in PROGRAMMES:
            elig = [m for m in members if m in future and m in idx]
            if len(elig) > 1:
                best = min(elig, key=lambda m: idx[m])
                future -= set(elig) - {best}
        pos = future & set(order)
        if len(pos) < 3:
            rows.append({"cutoff": cutoff, "n_pos": len(pos), "auc": None})
            continue
        a = auc(order, pos)
        ranks = sorted(idx[s] for s in pos)
        med = (ranks[len(ranks)//2] + 1) / len(order)
        n_better = 0
        for _ in range(10000):
            s = sorted(random.sample(range(len(order)), len(pos)))
            if (s[len(s)//2] + 1) / len(order) <= med:
                n_better += 1
        rows.append({"cutoff": cutoff, "n_universe": len(order), "n_pos": len(pos),
                     "auc": round(a, 3), "median_pct": round(med, 3),
                     "p": round((n_better + 1) / 10001, 5),
                     "positives": sorted(pos, key=lambda s: idx[s])})
    json.dump(rows, open(os.path.join(OUT, "sweep.json"), "w"), indent=1)

    print(f"{'CUTOFF':<8}{'UNIVERSE':>9}{'POS':>5}{'AUC':>7}{'MED%':>7}{'p':>9}   POSITIVES (by rank)")
    for r in rows:
        if r["auc"] is None:
            print(f"{r['cutoff']:<8}{'':>9}{r['n_pos']:>5}{'  n/a':>7}   too few positives")
            continue
        print(f"{r['cutoff']:<8}{r['n_universe']:>9}{r['n_pos']:>5}{r['auc']:>7.3f}"
              f"{r['median_pct']*100:>6.0f}%{r['p']:>9.4f}   {', '.join(r['positives'])}")
    aucs = [r["auc"] for r in rows if r["auc"]]
    print(f"\nAUC across {len(aucs)} cutoffs: min {min(aucs):.3f}, "
          f"median {sorted(aucs)[len(aucs)//2]:.3f}, max {max(aucs):.3f}")


if __name__ == "__main__":
    main()
