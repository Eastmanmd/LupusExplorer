"""Fetch drugs against each target in *other* immune-mediated diseases.

A target with an approved drug in rheumatoid arthritis or Sjogren's is
human-validated pharmacology sitting one indication away from lupus. This
walks the curated indication list in config.CROSS_INDICATIONS and inverts the
result into {gene symbol: [{drug, stage, disease, weight}, ...]}.

Writes cache/cross_drugs.json.
"""
import json
import time
from collections import defaultdict

import requests

import config

QUERY = """
query indicationDrugs($efoId: String!) {
  disease(efoId: $efoId) {
    name
    drugAndClinicalCandidates {
      count
      rows {
        maxClinicalStage
        drug {
          name
          drugType
          mechanismsOfAction {
            rows { actionType targets { approvedSymbol } }
          }
        }
      }
    }
  }
}
"""

STAGE_ORDER = ["UNKNOWN", "PRECLINICAL", "PHASE_1", "PHASE_1_2", "PHASE_2",
               "PHASE_2_3", "PHASE_3", "APPROVAL"]


def rank(stage):
    return STAGE_ORDER.index(stage) if stage in STAGE_ORDER else 0


def main():
    session = requests.Session()
    by_gene = defaultdict(list)
    for efo_id, (label, weight) in config.CROSS_INDICATIONS.items():
        for attempt in range(5):
            try:
                r = session.post(config.OPENTARGETS_GRAPHQL,
                                 json={"query": QUERY, "variables": {"efoId": efo_id}},
                                 timeout=120)
                r.raise_for_status()
                payload = r.json()
                if "errors" in payload:
                    raise RuntimeError(payload["errors"])
                break
            except Exception as e:
                print(f"  {label}: retry {attempt + 1}: {e}")
                time.sleep(2 ** attempt)
        else:
            print(f"  {label}: SKIPPED after 5 failures")
            continue

        disease = payload["data"]["disease"]
        if not disease:
            print(f"  {label} ({efo_id}): not found in Open Targets — skipped")
            continue
        rows = (disease["drugAndClinicalCandidates"] or {}).get("rows") or []
        seen = set()
        for row in rows:
            drug = row.get("drug") or {}
            name = drug.get("name")
            if not name:
                continue
            stage = row.get("maxClinicalStage") or "UNKNOWN"
            for mech in (drug.get("mechanismsOfAction") or {}).get("rows") or []:
                for target in mech.get("targets") or []:
                    symbol = target.get("approvedSymbol")
                    if not symbol or (symbol, name) in seen:
                        continue
                    seen.add((symbol, name))
                    by_gene[symbol].append({
                        "drug": name.title(),
                        "stage": stage,
                        "disease": label,
                        "weight": weight,
                        "action": (mech.get("actionType") or "").lower(),
                        "type": drug.get("drugType") or "",
                    })
        print(f"  {label}: {len(rows)} drug rows")
        time.sleep(0.3)

    # Keep the most advanced entry per (gene, drug, disease), best stage first.
    out = {}
    for symbol, entries in by_gene.items():
        best = {}
        for e in entries:
            key = (e["drug"], e["disease"])
            if key not in best or rank(e["stage"]) > rank(best[key]["stage"]):
                best[key] = e
        ordered = sorted(best.values(),
                         key=lambda e: (-rank(e["stage"]), -e["weight"], e["drug"]))
        out[symbol] = ordered[:20]

    with open(config.CROSS_DRUGS_FILE, "w") as f:
        json.dump(out, f)
    approved = sum(1 for v in out.values() if v and v[0]["stage"] == "APPROVAL")
    print(f"Wrote {len(out)} targets with drugs in other immune-mediated "
          f"indications ({approved} with an approved drug) to {config.CROSS_DRUGS_FILE}")


if __name__ == "__main__":
    main()
