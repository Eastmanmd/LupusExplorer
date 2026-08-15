"""Run GO-BP / KEGG / Reactome enrichment on the top-ranked genes via g:Profiler.

Reads data/genes.json (produced by build_data.py --skip-enrichment first pass),
writes cache/enrichment.json. build_data.py then folds the results into
data/pathways.json and per-gene pathway lists.
"""
import json
import os

import requests

import config

MAX_TERMS_PER_SOURCE = 40


def main():
    genes_path = os.path.join(config.DATA_DIR, "genes.json")
    with open(genes_path) as f:
        genes = json.load(f)["genes"]
    symbols = [g["symbol"] for g in genes]
    print(f"Running g:Profiler enrichment on {len(symbols)} genes")

    r = requests.post(
        config.GPROFILER_URL,
        json={
            "organism": "hsapiens",
            "query": symbols,
            "sources": ["GO:BP", "KEGG", "REAC"],
            "user_threshold": 0.05,
            "significance_threshold_method": "g_SCS",
            "no_evidences": False,
        },
        timeout=300,
    )
    r.raise_for_status()
    payload = r.json()
    results = payload["result"]
    # Each result's "intersections" aligns with the *mapped ENSG list*
    # (meta.genes_metadata.query.<name>.ensgs), not the submitted symbol
    # order — unmapped symbols are dropped, shifting the indices. Map each
    # ENSG back to its input symbol via the "mapping" dict.
    qdata = list(payload["meta"]["genes_metadata"]["query"].values())[0]
    ensgs = qdata["ensgs"]
    ensg_to_symbol = {}
    for symbol, ids in qdata["mapping"].items():
        for ensg in ids:
            ensg_to_symbol.setdefault(ensg, symbol)

    per_source = {}
    for res in results:
        source = res["source"]
        members = []
        if res.get("intersections"):
            members = sorted({ensg_to_symbol.get(ensgs[i], ensgs[i])
                              for i, ev in enumerate(res["intersections"])
                              if ev and i < len(ensgs)})
        per_source.setdefault(source, []).append({
            "id": res["native"],
            "name": res["name"],
            "source": source,
            "p_value": res["p_value"],
            "term_size": res["term_size"],
            "intersection_size": res["intersection_size"],
            "genes": members,
        })

    trimmed = []
    for source, terms in per_source.items():
        terms.sort(key=lambda t: t["p_value"])
        trimmed.extend(terms[:MAX_TERMS_PER_SOURCE])

    with open(config.ENRICHMENT_FILE, "w") as f:
        json.dump(trimmed, f)
    counts = {s: len(t[:MAX_TERMS_PER_SOURCE]) for s, t in per_source.items()}
    print(f"Wrote {len(trimmed)} enriched terms {counts} to {config.ENRICHMENT_FILE}")


if __name__ == "__main__":
    main()
