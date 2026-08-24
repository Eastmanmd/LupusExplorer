"""Assemble the candidate holdout set for the retrospective (time-travel) validation.

READ-ONLY with respect to cache/ and data/: this script never writes there.
Outputs land in analysis/out/.

The question: among genes that were NOT yet in the SLE clinic as of the cutoff,
did the cutoff-year score rank the ones that subsequently entered clinical
development above chance?
"""
import json, os, collections

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)

CUTOFF = 2015
MIN_PAPERS = 5          # mirrors config.MIN_PAPERS_FOR_CANDIDATE
MAX_GENES_PER_DRUG = 5  # drop complex/family fan-out (bortezomib -> 38 subunits)

# Agents whose SLE use is supportive care, symptom management, or a comorbidity
# indication rather than a mechanism-driven SLE target programme. Excluded so
# the holdout measures target discovery, not polypharmacy.
NON_SPECIFIC = {
    "Aspirin", "Ibuprofen", "Meloxicam", "Sulfasalazine", "Atorvastatin",
    "Rosuvastatin", "Simvastatin", "Ezetimibe", "Ramipril", "Clopidogrel",
    "Duloxetine", "Modafinil", "Naltrexone", "Ketamine", "Memantine",
    "Pioglitazone", "Cholecalciferol", "Ergocalciferol", "Arsenic Trioxide",
    "Filgrastim", "Lenograstim", "Pegfilgrastim", "Nivolumab",
    "Estradiol", "Estrogens, Conjugated", "Ethinyl Estradiol", "Fulvestrant",
    "Medroxyprogesterone Acetate", "Norethindrone", "Levosalbutamol",
}
# Broad cytotoxics / classical immunosuppressants: in SLE use for decades,
# not discoveries, and mostly multi-subunit targets anyway.
CLASSICAL = {
    "Methotrexate", "Azathioprine", "Mycophenolate Mofetil", "Mycophenolate Sodium",
    "Cyclosporine", "Sirolimus", "Tacrolimus Anhydrous", "Leflunomide",
    "Hydroxychloroquine", "Hydroxychloroquine Sulfate", "Betamethasone",
    "Betamethasone Sodium Phosphate", "Cortisone Acetate", "Dexamethasone",
    "Dexamethasone Sodium Phosphate", "Hydrocortisone", "Prednisone",
    "Prednisolone", "Methylprednisolone", "Triamcinolone", "Cyclophosphamide",
    "Cytarabine", "Fludarabine Phosphate", "Bortezomib", "Brentuximab Vedotin",
    "Lenalidomide", "Aldesleukin",
}
DROP_DRUGS = NON_SPECIFIC | CLASSICAL


def main():
    drugs = json.load(open(os.path.join(ROOT, "cache", "drugs.json")))
    genes = {g["symbol"]: g for g in
             json.load(open(os.path.join(ROOT, "data", "genes.json")))["genes"]}

    # How many genes does each drug hit? Wide fan-out = complex or family.
    fanout = collections.Counter()
    for sym, v in drugs.items():
        for d in v.get("drugs", []):
            fanout[d["drug"]] += 1

    # --- the 2015-rankable universe -------------------------------------
    papers_by_gene = collections.Counter()
    with open(os.path.join(ROOT, "cache", "mentions.jsonl")) as f:
        for line in f:
            rec = json.loads(line)
            if rec.get("year") is None or rec["year"] > CUTOFF:
                continue
            for g in {x for x in rec.get("genes", [])}:
                papers_by_gene[g if isinstance(g, str) else str(g)] += 1
    universe = {g for g, n in papers_by_gene.items() if n >= MIN_PAPERS}

    # --- candidate positives --------------------------------------------
    rows = []
    for sym, v in drugs.items():
        keep = [d for d in v.get("drugs", [])
                if d["drug"] not in DROP_DRUGS
                and fanout[d["drug"]] <= MAX_GENES_PER_DRUG]
        if not keep:
            continue
        rows.append({
            "symbol": sym,
            "in_top300": sym in genes,
            "lit_rank": genes.get(sym, {}).get("rank"),
            "top_stage": v.get("top_stage"),
            "drugs": sorted({d["drug"] for d in keep}),
        })
    rows.sort(key=lambda r: (r["lit_rank"] is None, r["lit_rank"] or 0))

    json.dump({"cutoff": CUTOFF, "candidates": rows},
              open(os.path.join(OUT, "holdout_candidates.json"), "w"), indent=1)

    print(f"2015-rankable universe (>={MIN_PAPERS} papers by {CUTOFF}): "
          f"{len(universe)} genes")
    print(f"candidate drugged genes after filtering: {len(rows)} "
          f"(from {len(drugs)} raw)\n")
    print(f"{'SYMBOL':<11}{'RANK':>5}  {'STAGE':<12} DRUGS")
    for r in rows:
        if not r["in_top300"]:
            continue
        ds = ", ".join(r["drugs"][:4]) + (" ..." if len(r["drugs"]) > 4 else "")
        print(f"{r['symbol']:<11}{str(r['lit_rank']):>5}  {r['top_stage']:<12} {ds}")


if __name__ == "__main__":
    main()
