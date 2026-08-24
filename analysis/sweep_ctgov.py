"""The cutoff sweep, re-run with ClinicalTrials.gov first-posted dates in place
of hand-assigned entry years. Same machinery as sweep_cutoffs.py otherwise.
"""
import json, os, random
from sweep_cutoffs import load, score_at, auc, PROGRAMMES

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")

dates = json.load(open(os.path.join(OUT, "ctgov_dates.json")))
ENTRY = {s: e["year"] for s, e in dates.items()}

info, recs = load()
random.seed(0)
rows = []
print(f"{'CUTOFF':<8}{'UNIV':>6}{'POS':>5}{'AUC':>7}{'MED%':>7}{'p':>9}   POSITIVES (by rank)")
for cutoff in range(2010, 2019):
    genes = score_at(info, recs, cutoff)
    order_all = [g["symbol"] for g in genes]
    rankable = set(order_all)
    order = [s for s in order_all if ENTRY.get(s, 9999) > cutoff]
    future = {s for s, y in ENTRY.items() if y > cutoff and s in rankable}
    idx = {s: i for i, s in enumerate(order)}
    for members in PROGRAMMES:
        elig = [m for m in members if m in future and m in idx]
        if len(elig) > 1:
            best = min(elig, key=lambda m: idx[m])
            future -= set(elig) - {best}
    pos = future & set(order)
    if len(pos) < 3:
        print(f"{cutoff:<8}{len(order):>6}{len(pos):>5}    n/a   too few positives")
        rows.append({"cutoff": cutoff, "n_pos": len(pos), "auc": None}); continue
    a = auc(order, pos)
    ranks = sorted(idx[s] for s in pos)
    med = (ranks[len(ranks)//2] + 1) / len(order)
    nb = sum(1 for _ in range(10000)
             if (lambda s: (s[len(s)//2]+1)/len(order) <= med)
                (sorted(random.sample(range(len(order)), len(pos)))))
    p = (nb+1)/10001
    rows.append({"cutoff": cutoff, "n_universe": len(order), "n_pos": len(pos),
                 "auc": round(a,3), "median_pct": round(med,3), "p": round(p,5),
                 "positives": sorted(pos, key=lambda s: idx[s])})
    print(f"{cutoff:<8}{len(order):>6}{len(pos):>5}{a:>7.3f}{med*100:>6.0f}%{p:>9.4f}   "
          f"{', '.join(sorted(pos, key=lambda s: idx[s]))}")
json.dump(rows, open(os.path.join(OUT, "sweep_ctgov.json"), "w"), indent=1)
aucs = [r["auc"] for r in rows if r["auc"]]
print(f"\nAUC across {len(aucs)} cutoffs: min {min(aucs):.3f}, "
      f"median {sorted(aucs)[len(aucs)//2]:.3f}, max {max(aucs):.3f}")
