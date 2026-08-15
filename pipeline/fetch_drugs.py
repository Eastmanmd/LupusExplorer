"""Fetch drugs and clinical candidates for SLE from the Open Targets Platform.

Writes cache/drugs.json: {gene symbol: [{drug, stage, action, type}, ...]}
Every row comes back in a single query — no pagination, no API key.
"""
import json
import time
from collections import defaultdict

import requests

import config

QUERY = """
query sleDrugs($efoId: String!) {
  disease(efoId: $efoId) {
    drugAndClinicalCandidates {
      count
      rows {
        maxClinicalStage
        drug {
          id
          name
          drugType
          mechanismsOfAction {
            rows {
              actionType
              mechanismOfAction
              targets { approvedSymbol }
            }
          }
        }
      }
    }
  }
}
"""

# Ranked worst → best so a gene's badge reflects its most advanced candidate.
STAGE_ORDER = ["UNKNOWN", "PRECLINICAL", "PHASE_1", "PHASE_1_2", "PHASE_2",
               "PHASE_2_3", "PHASE_3", "APPROVAL"]


def main():
    session = requests.Session()
    for attempt in range(5):
        try:
            r = session.post(config.OPENTARGETS_GRAPHQL,
                             json={"query": QUERY, "variables": {"efoId": config.SLE_EFO_ID}},
                             timeout=120)
            r.raise_for_status()
            payload = r.json()
            if "errors" in payload:
                raise RuntimeError(payload["errors"])
            break
        except Exception as e:
            print(f"  retry {attempt + 1}: {e}")
            time.sleep(2 ** attempt)
    else:
        raise RuntimeError("Open Targets drug fetch failed")

    block = payload["data"]["disease"]["drugAndClinicalCandidates"]
    rows = block["rows"]
    print(f"{block['count']} SLE drug/candidate rows returned ({len(rows)} fetched)")

    by_gene = defaultdict(dict)   # symbol -> {drug name: record}
    for row in rows:
        drug = row["drug"] or {}
        name = drug.get("name")
        if not name:
            continue
        stage = row.get("maxClinicalStage") or "UNKNOWN"
        mechanisms = (drug.get("mechanismsOfAction") or {}).get("rows") or []
        for mech in mechanisms:
            action = mech.get("actionType") or ""
            for target in mech.get("targets") or []:
                symbol = target.get("approvedSymbol")
                if not symbol:
                    continue
                prev = by_gene[symbol].get(name)
                # keep the most advanced stage if a drug appears more than once
                if prev and STAGE_ORDER.index(prev["stage"]) >= _rank(stage):
                    continue
                by_gene[symbol][name] = {
                    "drug": name.title(),
                    "stage": stage,
                    "action": action.lower(),
                    "type": drug.get("drugType") or "",
                }

    out = {}
    for symbol, drugs in by_gene.items():
        ordered = sorted(drugs.values(), key=lambda d: -_rank(d["stage"]))
        out[symbol] = {
            "top_stage": ordered[0]["stage"],
            "drugs": ordered[:12],
        }
    with open(config.DRUGS_FILE, "w") as f:
        json.dump(out, f)
    approved = sum(1 for v in out.values() if v["top_stage"] == "APPROVAL")
    print(f"Wrote {len(out)} targets with SLE drugs ({approved} with an approved drug) "
          f"to {config.DRUGS_FILE}")


def _rank(stage):
    return STAGE_ORDER.index(stage) if stage in STAGE_ORDER else 0


if __name__ == "__main__":
    main()
