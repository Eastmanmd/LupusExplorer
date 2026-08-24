"""Evaluate the 2015 literature score as a predictor of subsequent SLE clinical
entry: AUC, precision@k, and a permutation test against random ranking.

Universe = genes rankable at the cutoff, MINUS genes already in the SLE clinic
by then (a 2015 observer already knew about those, so including them would be
scoring the model on what it could not have been wrong about).
Positives = genes whose first SLE clinical entry falls after the cutoff.
"""
import json, os, random

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")

# PROVISIONAL — assigned from SLE development timelines, not from a dated
# source. Open Targets carries no first-in-SLE date, so these need review.
POST_2015 = ["TYK2", "CD19", "CD38", "CLEC4C", "TNFRSF13C", "BTK", "JAK1",
             "S1PR1", "CD40", "BCL2", "IFNB1", "TLR8", "FCGR2B", "ICOS",
             "IL12B", "IL23A", "IL12A", "IL17A", "JAK2", "JAK3", "TLR7"]
PRE_2015 = ["TNFSF13B", "TNF", "IL6", "IFNG", "CD40LG", "IFNAR1", "CD80",
            "CD86", "CD22", "MS4A1", "SYK", "HSPA8", "TNFSF13", "CD28",
            "IGHE", "NR3C1"]


def auc(ranked_syms, positives):
    """P(random positive ranks above random negative). Ties impossible here."""
    pos_idx = [i for i, s in enumerate(ranked_syms) if s in positives]
    n_pos, n_neg = len(pos_idx), len(ranked_syms) - len(pos_idx)
    if not n_pos or not n_neg:
        return None
    # rank-sum form: count negatives each positive beats
    beat = sum(len(ranked_syms) - 1 - i - sum(1 for j in pos_idx if j > i)
               for i in pos_idx)
    return beat / (n_pos * n_neg)


def main():
    data = json.load(open(os.path.join(OUT, "scores_2015.json")))
    ranked = [g["symbol"] for g in data["genes"]]
    excluded = set(PRE_2015)
    universe = [s for s in ranked if s not in excluded]
    pos = set(POST_2015) & set(universe)
    unranked = [s for s in POST_2015 if s not in ranked]

    print(f"cutoff {data['cutoff']} | universe {len(universe)} genes "
          f"({len(ranked)} rankable - {len(excluded & set(ranked))} already in clinic)")
    print(f"positives {len(pos)} ranked" +
          (f", {len(unranked)} unrankable at cutoff: {', '.join(unranked)}" if unranked else ""))

    a = auc(universe, pos)
    print(f"\nAUC = {a:.3f}   (0.50 = chance)")

    print("\nprecision@k / recall@k:")
    for k in (25, 50, 100, 150, 200, 300):
        hits = sum(1 for s in universe[:k] if s in pos)
        exp = k * len(pos) / len(universe)
        print(f"  top {k:>3}: {hits:>2} of {len(pos)} positives  "
              f"(precision {hits/k:>5.1%}, expected by chance {exp:4.1f}, "
              f"enrichment {hits/exp if exp else 0:.1f}x)")

    # permutation test on median percentile of positives
    random.seed(0)
    obs = sorted(universe.index(s) for s in pos)
    obs_med = (obs[len(obs)//2] + 1) / len(universe)
    n_better = 0
    for _ in range(20000):
        samp = random.sample(range(len(universe)), len(pos))
        samp.sort()
        if (samp[len(samp)//2] + 1) / len(universe) <= obs_med:
            n_better += 1
    print(f"\nmedian percentile of positives = {obs_med:.1%} (chance ~50%)")
    print(f"permutation p = {(n_better + 1) / 20001:.5f}  (20,000 draws)")

    json.dump({"cutoff": data["cutoff"], "auc": a, "n_universe": len(universe),
               "n_positives": len(pos), "median_percentile": obs_med,
               "unrankable_positives": unranked},
              open(os.path.join(OUT, "evaluation_2015.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
