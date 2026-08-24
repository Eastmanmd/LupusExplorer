"""Is the lupus literature score lupus-specific, or does it just find genes that
get drugged in any immune disease?

For each of the 30 curated cross-indications, ask the same question we asked of
SLE: does the 2015 lupus-literature ranking separate genes that have a drug in
that indication from genes that don't?

Label source is held constant (Open Targets drug records, same filters) so SLE
and the comparators are scored the same way. This is NOT date-matched -- the
cross-indication records are current, so it measures specificity of the ranking,
not predictive timing.
"""
import json, os, random
from collections import defaultdict
from sweep_cutoffs import load, score_at, auc
from build_holdout import DROP_DRUGS, MAX_GENES_PER_DRUG

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, "out")
CUTOFF = 2015

def filtered(pairs, fan):
    return {d for d in pairs if d not in DROP_DRUGS and fan[d] <= MAX_GENES_PER_DRUG}

def main():
    cross = json.load(open(os.path.join(ROOT, "cache", "cross_drugs.json")))
    sle = json.load(open(os.path.join(ROOT, "cache", "drugs.json")))

    fan = defaultdict(int)
    for sym, v in sle.items():
        for d in v.get("drugs", []):
            fan[d["drug"]] += 1
    fan_x = defaultdict(set)
    for sym, rows in cross.items():
        for r in rows:
            fan_x[r["drug"]].add(sym)
    fanx = {d: len(g) for d, g in fan_x.items()}

    by_disease = defaultdict(set)
    for sym, rows in cross.items():
        for r in rows:
            d = r["drug"]
            if d in DROP_DRUGS or fanx.get(d, 0) > MAX_GENES_PER_DRUG:
                continue
            by_disease[r["disease"]].add(sym)
    by_disease["SYSTEMIC LUPUS ERYTHEMATOSUS"] = {
        s for s, v in sle.items()
        if filtered({d["drug"] for d in v.get("drugs", [])}, fan)}

    info, recs = load()
    genes = score_at(info, recs, CUTOFF)
    order = [g["symbol"] for g in genes]
    universe = set(order)
    random.seed(0)

    rows = []
    for disease, syms in by_disease.items():
        pos = syms & universe
        if len(pos) < 5:
            continue
        a = auc(order, pos)
        idx = {s: i for i, s in enumerate(order)}
        r = sorted(idx[s] for s in pos)
        med = (r[len(r)//2] + 1) / len(order)
        rows.append((a, disease, len(pos), med))
    rows.sort(reverse=True)

    print(f"2015 lupus literature ranking ({len(order)} genes) as a predictor of "
          f"'has a drug in disease X'\n")
    print(f"{'AUC':>6}  {'N POS':>5}  {'MED%':>5}  DISEASE")
    for a, disease, n, med in rows:
        star = "  <-- SLE" if "LUPUS" in disease.upper() else ""
        print(f"{a:>6.3f}  {n:>5}  {med*100:>4.0f}%  {disease}{star}")

    others = [a for a, d, n, m in rows if "LUPUS" not in d.upper()]
    sle_auc = [a for a, d, n, m in rows if "LUPUS" in d.upper()][0]
    print(f"\nSLE AUC {sle_auc:.3f} vs other indications: "
          f"median {sorted(others)[len(others)//2]:.3f}, max {max(others):.3f}")
    print(f"SLE ranks {sorted(others + [sle_auc], reverse=True).index(sle_auc)+1} "
          f"of {len(rows)} indications")
    json.dump([{"disease": d, "auc": a, "n_pos": n, "median_pct": m}
               for a, d, n, m in rows],
              open(os.path.join(OUT, "negative_control.json"), "w"), indent=1)

if __name__ == "__main__":
    main()
