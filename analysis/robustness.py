"""Two ways the headline AUC could be inflated, tested.

1. Component ablation - is 'recency' doing any work, or is this just
   'well-studied genes get drugged'?
2. Programme clustering - IL12A/IL12B/IL23A are all ustekinumab; the jakinibs
   hit JAK1/2/3+TYK2. Counting those as independent positives inflates n.
"""
import json, math, os, random
from evaluate import auc, POST_2015, PRE_2015

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")

# One entry per clinical programme: only the best-ranked member counts.
PROGRAMMES = {
    "ustekinumab (IL-12/23)": ["IL12A", "IL12B", "IL23A"],
    "jakinibs":               ["JAK1", "JAK2", "JAK3", "TYK2"],
    "obexelimab":             ["CD19", "FCGR2B"],
    "TLR7/8 antagonists":     ["TLR7", "TLR8"],
}


def load():
    d = json.load(open(os.path.join(OUT, "scores_2015.json")))
    return d["genes"]


def rank_by(genes, key):
    return [g["symbol"] for g in sorted(genes, key=lambda g: -g[key])]


def main():
    genes = load()
    excluded = set(PRE_2015)

    print("=== 1. component ablation (AUC) ===")
    for label, key in [("combined (0.57 mentions + 0.43 recency)", "score"),
                       ("mentions only", "mention_norm"),
                       ("recency only", "recency_norm"),
                       ("velocity only (5y/5y ratio)", "velocity")]:
        order = [s for s in rank_by(genes, key) if s not in excluded]
        pos = set(POST_2015) & set(order)
        print(f"  {label:<42} AUC = {auc(order, pos):.3f}")

    print("\n=== 2. collapsing co-targeted genes to one per programme ===")
    order = [s for s in rank_by(genes, "score") if s not in excluded]
    idx = {s: i for i, s in enumerate(order)}
    drop = set()
    for name, members in PROGRAMMES.items():
        present = [m for m in members if m in idx]
        if len(present) > 1:
            best = min(present, key=lambda m: idx[m])
            drop |= set(present) - {best}
            print(f"  {name:<24} keep {best:<8} drop {', '.join(sorted(set(present)-{best}))}")
    order2 = [s for s in order if s not in drop]
    pos2 = (set(POST_2015) & set(order2))
    a2 = auc(order2, pos2)
    print(f"\n  {len(pos2)} independent positives (was 19)")
    print(f"  AUC = {a2:.3f}")

    random.seed(0)
    obs = sorted(order2.index(s) for s in pos2)
    obs_med = (obs[len(obs) // 2] + 1) / len(order2)
    n_better = sum(1 for _ in range(20000)
                   if (lambda s: (s[len(s)//2] + 1) / len(order2) <= obs_med)
                      (sorted(random.sample(range(len(order2)), len(pos2)))))
    print(f"  median percentile {obs_med:.1%}, permutation p = {(n_better+1)/20001:.5f}")

    for k in (25, 50, 100):
        hits = sum(1 for s in order2[:k] if s in pos2)
        exp = k * len(pos2) / len(order2)
        print(f"  top {k:>3}: {hits} of {len(pos2)}  (enrichment {hits/exp:.1f}x)")


if __name__ == "__main__":
    main()
