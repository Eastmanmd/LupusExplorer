"""Fetch drug-discovery profile data for each ranked gene from Open Targets.

This is the druggability half of the picture: the existing fetchers answer
"is this gene associated with lupus?", this one answers "could it be drugged,
should it be drugged, and is anyone already doing it?".

Writes cache/target_profile.json: {symbol: {ensembl, prio, tract, lof, classes,
safety, locations, essential, partners}}.
"""
import json
import os
import time

import requests

import config

BATCH = 20          # targets per GraphQL call
PARTNERS = 50       # IntAct interactors kept per target

PROFILE_QUERY = """
query profiles($ids: [String!]!) {
  targets(ensemblIds: $ids) {
    id
    approvedSymbol
    isEssential
    prioritisation { items { key value } }
    tractability { label modality value }
    geneticConstraint { constraintType oe upperBin6 upperRank }
    targetClass { id label level }
    safetyLiabilities { event datasource }
    subcellularLocations { location source labelSL }
    interactions(sourceDatabase: intact, page: {index: 0, size: %d}) {
      count
      rows { score targetB { approvedSymbol } }
    }
  }
}
""" % PARTNERS

MAP_QUERY = """
query mapIds($terms: [String!]!) {
  mapIds(queryTerms: $terms, entityNames: ["target"]) {
    mappings { term hits { id name entity } }
  }
}
"""


def post(session, query, variables, timeout=120):
    for attempt in range(5):
        try:
            r = session.post(config.OPENTARGETS_GRAPHQL,
                             json={"query": query, "variables": variables},
                             timeout=timeout)
            r.raise_for_status()
            payload = r.json()
            if "errors" in payload:
                raise RuntimeError(payload["errors"])
            return payload["data"]
        except Exception as e:
            print(f"  retry {attempt + 1}: {e}")
            time.sleep(2 ** attempt)
    raise RuntimeError("Open Targets request failed after 5 attempts")


def ranked_symbols():
    """Every gene the dashboard ranks, best first."""
    path = os.path.join(config.DATA_DIR, "genes.json")
    if not os.path.exists(path):
        raise SystemExit("data/genes.json missing — run build_data.py first")
    with open(path) as f:
        return [g["symbol"] for g in json.load(f)["genes"]]


def resolve_ensembl(session, symbols):
    """Symbol -> Ensembl gene id, preferring the SLE association cache."""
    ids = {}
    if os.path.exists(config.OPENTARGETS_FILE):
        with open(config.OPENTARGETS_FILE) as f:
            for symbol, rec in json.load(f).items():
                if rec.get("ensembl"):
                    ids[symbol] = rec["ensembl"]
    todo = [s for s in symbols if s not in ids]
    if todo:
        print(f"Resolving {len(todo)} symbols not in the SLE association set")
        for i in range(0, len(todo), 50):
            batch = todo[i:i + 50]
            data = post(session, MAP_QUERY, {"terms": batch})
            for m in data["mapIds"]["mappings"]:
                # mapIds is fuzzy — only trust an exact symbol match
                for hit in m["hits"]:
                    if hit["name"].upper() == m["term"].upper():
                        ids[m["term"]] = hit["id"]
                        break
            time.sleep(0.3)
    unresolved = [s for s in symbols if s not in ids]
    if unresolved:
        print(f"  no Ensembl id for {len(unresolved)}: {', '.join(unresolved)}")
    return {s: ids[s] for s in symbols if s in ids}


def compact(target):
    """Trim a Target payload down to what the scorer actually reads."""
    prio = {}
    for item in (target.get("prioritisation") or {}).get("items", []):
        try:
            prio[item["key"]] = float(item["value"])
        except (TypeError, ValueError):
            continue

    # Tractability arrives as one boolean per (modality, assessment); keep only
    # the assessments that are true, grouped by modality.
    tract = {}
    for row in target.get("tractability") or []:
        if row.get("value"):
            tract.setdefault(row["modality"], []).append(row["label"])

    lof = {}
    for row in target.get("geneticConstraint") or []:
        if row.get("constraintType") == "lof":
            lof = {"oe": row.get("oe"), "bin": row.get("upperBin6"),
                   "rank": row.get("upperRank")}

    classes = [c["label"] for c in (target.get("targetClass") or [])
               if c.get("level") == "l1"]
    classes_l2 = [c["label"] for c in (target.get("targetClass") or [])
                  if c.get("level") == "l2"]

    safety = sorted({s["event"] for s in (target.get("safetyLiabilities") or [])
                     if s.get("event")})
    locations = sorted({loc["location"] for loc in
                        (target.get("subcellularLocations") or [])
                        if loc.get("source") == "uniprot" and loc.get("location")})

    interactions = target.get("interactions") or {}
    partners = {}
    for row in interactions.get("rows") or []:
        tb = row.get("targetB") or {}
        symbol = tb.get("approvedSymbol")
        if not symbol or symbol == target["approvedSymbol"]:
            continue
        partners[symbol] = max(partners.get(symbol, 0), row.get("score") or 0)

    return {
        "ensembl": target["id"],
        "prio": {k: round(v, 4) for k, v in prio.items()},
        "tract": tract,
        "lof": lof,
        "classes": classes,
        "classes_l2": classes_l2,
        "safety": safety,
        "locations": locations[:8],
        "essential": target.get("isEssential"),
        "partner_count": interactions.get("count", 0),
        "partners": [{"symbol": s, "score": round(v, 2)}
                     for s, v in sorted(partners.items(), key=lambda kv: -kv[1])],
    }


def main():
    session = requests.Session()
    symbols = ranked_symbols()
    print(f"{len(symbols)} ranked genes to profile")
    ids = resolve_ensembl(session, symbols)
    by_ensembl = {v: k for k, v in ids.items()}

    profiles = {}
    ordered = list(ids.values())
    for i in range(0, len(ordered), BATCH):
        batch = ordered[i:i + BATCH]
        data = post(session, PROFILE_QUERY, {"ids": batch})
        for target in data["targets"] or []:
            if not target:
                continue
            symbol = by_ensembl.get(target["id"], target["approvedSymbol"])
            profiles[symbol] = compact(target)
        print(f"  {min(i + BATCH, len(ordered))}/{len(ordered)}")
        time.sleep(0.3)

    with open(config.TARGET_PROFILE_FILE, "w") as f:
        json.dump(profiles, f)
    tractable = sum(1 for p in profiles.values() if p["tract"])
    print(f"Wrote {len(profiles)} target profiles ({tractable} with tractability "
          f"evidence) to {config.TARGET_PROFILE_FILE}")


if __name__ == "__main__":
    main()
