"""Fetch gene-disease association scores for SLE from the Open Targets Platform."""
import json
import time

import requests

import config

QUERY = """
query sleAssociations($efoId: String!, $index: Int!) {
  disease(efoId: $efoId) {
    id
    name
    associatedTargets(page: {index: $index, size: 250}) {
      count
      rows {
        target { id approvedSymbol }
        score
        datatypeScores { id score }
      }
    }
  }
}
"""


def main():
    session = requests.Session()
    index = 0
    rows = []
    total = None
    while True:
        for attempt in range(5):
            try:
                r = session.post(
                    config.OPENTARGETS_GRAPHQL,
                    json={"query": QUERY,
                          "variables": {"efoId": config.SLE_EFO_ID, "index": index}},
                    timeout=60,
                )
                r.raise_for_status()
                payload = r.json()
                if "errors" in payload:
                    raise RuntimeError(payload["errors"])
                break
            except Exception as e:
                print(f"  retry {attempt + 1}: {e}")
                time.sleep(2 ** attempt)
        else:
            raise RuntimeError("Open Targets fetch failed")
        assoc = payload["data"]["disease"]["associatedTargets"]
        total = assoc["count"]
        page = assoc["rows"]
        if not page:
            break
        rows.extend(page)
        print(f"  {len(rows)}/{total}")
        if len(rows) >= total:
            break
        index += 1
        time.sleep(0.3)

    genes = {}
    for row in rows:
        symbol = row["target"]["approvedSymbol"]
        genes[symbol] = {
            "ensembl": row["target"]["id"],
            "score": row["score"],
            "datatypes": {d["id"]: d["score"] for d in row["datatypeScores"]},
        }
    with open(config.OPENTARGETS_FILE, "w") as f:
        json.dump(genes, f)
    print(f"Wrote {len(genes)} SLE-associated targets to {config.OPENTARGETS_FILE}")


if __name__ == "__main__":
    main()
