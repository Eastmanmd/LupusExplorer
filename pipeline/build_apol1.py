"""APOL1 in lupus: a ranked partner table and a two-ring co-mention map.

Two corpora meet here. The *table* answers the narrow question — which genes
does the lupus literature talk about alongside APOL1 — and is therefore built
only from papers in the lupus corpus. The *map* answers the wider one, because
the narrow answer alone cannot be drawn: 28 of the 40 lupus papers PubTator
tags with APOL1 name no other gene, leaving 24 partners, 20 of them seen once,
and exactly one partner-partner edge above weight 1. A graph on that is a
picture of two abstracts wearing a network's clothes.

So the map is built on the full APOL1 corpus and split into two rings:

  inner   partners the lupus literature has already connected to APOL1
  outer   partners established elsewhere in APOL1 biology that no lupus paper
          has co-mentioned

The gap between the rings is the point of the figure — it is a reading list,
not a decoration. Lupus co-mentions are still weighted APOL1_LUPUS_EDGE_WEIGHT
times an ordinary one, so the ordering everywhere (which partners make the cut,
how thick an edge draws) stays anchored to the lupus question even though the
structure comes from the wider corpus.

Outputs data/apol1.json.
"""
import itertools
import json
import math
import os
from collections import Counter, defaultdict

import config
from build_data import HUMAN_TAXID, MERGE_TAXIDS, fetch_gene_info, load_mentions
from build_network import log_hypergeom_sf, louvain, name_modules


def load_apol1_corpus():
    """PMID -> record, for every annotated paper in the APOL1 corpus."""
    records = {}
    with open(config.APOL1_MENTIONS_FILE) as f:
        for line in f:
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if rec.get("missing") or not rec.get("pmid"):
                continue
            records[rec["pmid"]] = rec
    return records


def wilson_lower(hits, total, z=1.96):
    """Lower bound of the 95% CI on hits/total.

    The share column is a ratio over a denominator that is sometimes 1, so
    100% can mean "the only lupus paper naming this gene also named APOL1".
    Sorting on the raw share alone would put those above MYH9's 4-of-7. The
    share is what gets displayed — it is the honest number and the one that was
    asked for — but ties and near-ties break on this bound, so a large share
    resting on one paper cannot outrank the same share resting on four. Same
    device build_emerging.py uses for the emergence score.
    """
    if not total:
        return 0.0
    p = hits / total
    d = 1 + z * z / total
    centre = p + z * z / (2 * total)
    margin = z * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total))
    return max(0.0, (centre - margin) / d)


def main():
    # --- the two corpora -----------------------------------------------------
    lupus_articles, lupus_gene_articles = load_mentions()
    with open(config.PMIDS_FILE) as f:
        lupus_pmids = {line.strip() for line in f if line.strip()}
    apol1_records = load_apol1_corpus()

    # Symbols, with mouse and rat homologs folded onto the human symbol exactly
    # as build_data does — a paper about Apol1 in mice is an APOL1 paper.
    every_gid = {g for r in apol1_records.values() for g in r["genes"]}
    every_gid |= set(lupus_gene_articles)
    info = fetch_gene_info(sorted(every_gid))
    symbol_of = {}
    for gid, gi in info.items():
        symbol, taxid = gi.get("symbol"), gi.get("taxid")
        if symbol and taxid in MERGE_TAXIDS:
            symbol_of[gid] = symbol.upper()
    human_entrez = {}
    for gid, gi in info.items():
        if gi.get("taxid") == HUMAN_TAXID and gi.get("symbol"):
            human_entrez.setdefault(gi["symbol"].upper(), gid)

    apol1 = symbol_of.get(config.APOL1_ENTREZ, "APOL1")

    # Total lupus papers per symbol: the table's denominator.
    lupus_papers = Counter()
    for gid, pmids in lupus_gene_articles.items():
        symbol = symbol_of.get(gid)
        if symbol:
            lupus_papers[symbol] += len(set(pmids))

    # --- co-mentions ---------------------------------------------------------
    corpus_size = len(apol1_records)
    apol1_papers, papers_in_corpus = [], Counter()
    for pmid, rec in apol1_records.items():
        symbols = {symbol_of[g] for g in rec["genes"] if g in symbol_of}
        symbols -= set(config.ALIAS_COLLISIONS)
        for s in symbols:
            papers_in_corpus[s] += 1
        if apol1 in symbols:
            apol1_papers.append({"pmid": pmid, "year": rec.get("year"),
                                 "journal": rec.get("journal", ""),
                                 "title": rec.get("title", ""),
                                 "lupus": pmid in lupus_pmids,
                                 "symbols": symbols})

    co_all, co_lupus = Counter(), Counter()
    for paper in apol1_papers:
        for s in paper["symbols"] - {apol1}:
            co_all[s] += 1
            if paper["lupus"]:
                co_lupus[s] += 1
    lupus_hits = sum(1 for p in apol1_papers if p["lupus"])
    print(f"{corpus_size} APOL1 papers annotated, PubTator tags {apol1} in "
          f"{len(apol1_papers)} ({lupus_hits} of them in the lupus corpus)")
    print(f"  {len(co_all)} partner genes, {len(co_lupus)} of them lupus-linked")

    # --- the table: lupus-linked partners only -------------------------------
    # Three metrics, all sortable in the browser, defaulting to the share.
    rows = []
    for symbol, hits in co_lupus.items():
        total = lupus_papers.get(symbol, 0)
        if hits < config.APOL1_TABLE_MIN_CO or not total:
            continue
        rows.append({
            "symbol": symbol,
            "name": (info.get(human_entrez.get(symbol, "")) or {}).get("name", ""),
            "entrez": human_entrez.get(symbol),
            "co_lupus": hits,             # papers with APOL1, inside the lupus corpus
            "lupus_papers": total,        # the gene's whole lupus literature
            "share": round(hits / total, 4),
            "share_lb": round(wilson_lower(hits, total), 4),
            "co_apol1": co_all[symbol],   # papers with APOL1, whole APOL1 corpus
        })
    rows.sort(key=lambda r: (-r["share"], -r["share_lb"], -r["co_lupus"], r["symbol"]))
    for i, r in enumerate(rows, 1):
        r["rank"] = i
    print(f"  table: {len(rows)} genes")

    # --- ring membership -----------------------------------------------------
    # A lupus co-mention is worth APOL1_LUPUS_EDGE_WEIGHT ordinary ones. This is
    # what keeps a map built on 1,300 nephrology papers answering a lupus
    # question: it decides which of the 800-odd partners are drawn at all.
    def strength(symbol):
        return (co_lupus.get(symbol, 0) * config.APOL1_LUPUS_EDGE_WEIGHT
                + (co_all[symbol] - co_lupus.get(symbol, 0)))

    inner = sorted(co_lupus, key=lambda s: (-strength(s), s))
    outer_pool = [s for s in co_all
                  if s not in co_lupus and co_all[s] >= config.APOL1_OUTER_MIN_CO]
    outer = sorted(outer_pool, key=lambda s: (-strength(s), s))[: config.APOL1_OUTER_MAX]
    partners = inner + outer
    partner_set = set(partners)
    print(f"  rings: {len(inner)} inner (lupus-linked), {len(outer)} outer "
          f"(APOL1 literature only, of {len(outer_pool)} eligible)")

    # --- partner-partner edges ----------------------------------------------
    # Gated on a hypergeometric tail over the APOL1 corpus, for the reason
    # build_network.py gates: without it the apolipoproteins co-occur with each
    # other constantly and say nothing. Broad surveys are skipped, same rule.
    pair, pair_lupus = Counter(), Counter()
    for paper in apol1_papers:
        others = sorted((paper["symbols"] & partner_set) - {apol1})
        if len(others) > config.NETWORK_MAX_PAPER_GENES:
            continue
        for combo in itertools.combinations(others, 2):
            pair[combo] += 1
            if paper["lupus"]:
                pair_lupus[combo] += 1

    ln_threshold = math.log(config.APOL1_PARTNER_P)
    edges = []
    for (a, b), count in pair.items():
        if count < config.APOL1_PARTNER_MIN_CO:
            continue
        log_p = log_hypergeom_sf(count, papers_in_corpus[a], papers_in_corpus[b],
                                 corpus_size)
        if log_p >= ln_threshold:
            continue
        edges.append({"a": a, "b": b, "co": count, "lupus": pair_lupus[(a, b)]})
    edges.sort(key=lambda e: (-e["co"], e["a"], e["b"]))
    print(f"  {len(pair)} partner pairs, {len(edges)} significant at "
          f"p < {config.APOL1_PARTNER_P}")

    # --- modules decide the wedges -------------------------------------------
    # The rings are radial, but the *angle* has to mean something or the picture
    # is a dartboard. Communities are found on the partner-partner graph and
    # each is given a wedge spanning both rings, so a module's lupus-linked and
    # lupus-unseen members sit on the same spoke of the figure: the empty arc of
    # an inner ring inside a busy outer wedge is exactly the gap being claimed.
    # Only genes that have an edge go to louvain. It drops edge-less nodes on
    # its first aggregation pass — build_network.py never notices because it
    # builds adjacency straight off its edge list, so nothing edge-less ever
    # reaches it — and seeding them here just loses them silently instead.
    adjacency = defaultdict(dict)
    for e in edges:
        adjacency[e["a"]][e["b"]] = float(e["co"])
        adjacency[e["b"]][e["a"]] = float(e["co"])
    modules = [m for m in louvain(adjacency, config.NETWORK_LAYOUT_SEED) if m]
    labels = name_modules(modules, partner_set, cache_file=config.APOL1_MODULES_FILE)
    module_of = {s: i for i, m in enumerate(modules) for s in m}

    # Genes with no partner-partner edge above the threshold still belong on the
    # rings — 13 of the 24 lupus-linked partners are here, and an inner ring
    # missing half its members would misrepresent the very thing the figure
    # claims to show. They get a wedge of their own, captioned for what they
    # are rather than left as an unexplained blank arc.
    unclustered = sorted(s for s in partners if s not in module_of)
    if unclustered:
        modules.append(unclustered)
        for s in unclustered:
            module_of[s] = len(modules) - 1
    unclustered_id = len(modules) - 1 if unclustered else None

    # --- radial layout -------------------------------------------------------
    # Deterministic, not a force simulation: with the ring a node sits on
    # carrying the whole meaning of the figure, a physics layout that pulls a
    # lupus-linked gene outward would be lying.
    W = H = 720.0
    cx = cy = W / 2
    R_INNER, R_OUTER = 196.0, 300.0
    order = sorted(range(len(modules)),
                   key=lambda i: (-len(modules[i]), modules[i][0]))

    # Wedge width is angular, but what has to fit is arc length, and the inner
    # ring has two thirds of the outer one's circumference. Splitting the circle
    # by raw member count therefore squeezes an inner-heavy module — the four
    # STING genes are all lupus-linked — into an arc barely wider than one gene
    # label, while a module that is entirely outer-ring gets room it does not
    # need. Each module asks for the angle its more crowded ring requires, and
    # the circle is divided on that.
    ring_members = {}
    need = {}
    for i in order:
        here = {}
        for ring_name, ring in (("lupus", inner), ("apol1", outer)):
            members = [s for s in ring if module_of.get(s) == i]
            members.sort(key=lambda s: (-strength(s), s))
            here[ring_name] = members
        ring_members[i] = here
        # Arc length a node needs, in pixels: an inner-ring gene carries a text
        # label, an outer-ring one is a dot until you ask for labels.
        need[i] = max(len(here["lupus"]) * 30.0 / R_INNER,
                      len(here["apol1"]) * 12.0 / R_OUTER)
    total_need = sum(need.values()) or 1.0

    angle_of, cursor = {}, -math.pi / 2
    module_arcs = []
    for i in order:
        span = 2 * math.pi * need[i] / total_need
        for members in ring_members[i].values():
            # Inset from the wedge edges so neighbouring modules stay legible.
            for j, s in enumerate(members):
                frac = (j + 0.5) / len(members)
                angle_of[s] = cursor + span * (0.08 + 0.84 * frac)
        module_arcs.append({"id": i, "start": round(cursor, 4),
                            "end": round(cursor + span, 4)})
        cursor += span

    # Even with per-ring wedge widths, two labels in a two-gene wedge sit about
    # 30px apart and their text touches. Alternating the radial offset of
    # consecutive inner-ring labels doubles the space each one has without
    # moving a single node, so the positions still mean what they claim.
    label_tier = {s: j % 2 for j, s in
                  enumerate(sorted(inner, key=lambda s: angle_of[s]))}

    def place(symbol, radius):
        a = angle_of[symbol]
        return [round(cx + radius * math.cos(a), 1), round(cy + radius * math.sin(a), 1)]

    nodes = [{"symbol": apol1, "name": "apolipoprotein L1",
              "entrez": config.APOL1_ENTREZ, "ring": "hub",
              "co_lupus": lupus_hits, "co_apol1": len(apol1_papers),
              "lupus_papers": lupus_papers.get(apol1, 0),
              "module": None, "x": round(cx, 1), "y": round(cy, 1)}]
    for ring, radius in (("lupus", R_INNER), ("apol1", R_OUTER)):
        for s in (inner if ring == "lupus" else outer):
            x, y = place(s, radius)
            nodes.append({
                "symbol": s,
                "name": (info.get(human_entrez.get(s, "")) or {}).get("name", ""),
                "entrez": human_entrez.get(s),
                "ring": ring,
                "co_lupus": co_lupus.get(s, 0),
                "co_apol1": co_all[s],
                "lupus_papers": lupus_papers.get(s, 0),
                "share": round(co_lupus.get(s, 0) / lupus_papers[s], 4)
                         if lupus_papers.get(s) else None,
                "weight": round(strength(s), 1),
                "module": module_of.get(s),
                "label_tier": label_tier.get(s, 0),
                "x": x, "y": y,
            })
    index = {n["symbol"]: i for i, n in enumerate(nodes)}

    # Spokes carry the same weighting as ring membership; partner-partner edges
    # ship both counts so the browser can thicken the lupus ones.
    edge_rows = [[0, index[s], co_all[s], co_lupus.get(s, 0), 1] for s in partners]
    edge_rows += [[index[e["a"]], index[e["b"]], e["co"], e["lupus"], 0]
                  for e in edges if e["a"] in index and e["b"] in index]

    module_rows = []
    for i, members in enumerate(modules):
        info_row = labels.get(f"m{i}")
        drawn = [s for s in members if s in partner_set]
        arc = next((a for a in module_arcs if a["id"] == i), None)
        module_rows.append({
            "id": i,
            "size": len(drawn),
            "inner": sum(1 for s in drawn if s in co_lupus),
            "genes": sorted(drawn),
            "label": ("no co-mention partner above threshold"
                      if i == unclustered_id
                      else info_row["term"] if info_row else None),
            "label_scope": None if i == unclustered_id
                           else info_row["scope"] if info_row else None,
            "unclustered": i == unclustered_id,
            "start": arc["start"] if arc else None,
            "end": arc["end"] if arc else None,
            "coloured": len(drawn) >= 3,
        })

    payload = {
        "gene": apol1,
        "query": config.APOL1_QUERY,
        "corpus_articles": corpus_size,
        "tagged_articles": len(apol1_papers),
        "lupus_articles": lupus_hits,
        "lupus_corpus_articles": len(lupus_articles),
        "lupus_weight": config.APOL1_LUPUS_EDGE_WEIGHT,
        "outer_min_co": config.APOL1_OUTER_MIN_CO,
        "partner_p": config.APOL1_PARTNER_P,
        "partners_total": len(co_all),
        "outer_eligible": len(outer_pool),
        "rows": rows,
        "network": {"width": W, "height": H, "cx": cx, "cy": cy,
                    "r_inner": R_INNER, "r_outer": R_OUTER,
                    "nodes": nodes, "edges": edge_rows, "modules": module_rows},
        "articles": sorted(
            ({"pmid": p["pmid"], "year": p["year"], "journal": p["journal"],
              "title": p["title"], "lupus": p["lupus"],
              "genes": sorted(p["symbols"] - {apol1})}
             for p in apol1_papers if p["lupus"]),
            key=lambda a: (-(a["year"] or 0), a["pmid"])),
    }
    os.makedirs(config.DATA_DIR, exist_ok=True)
    with open(config.APOL1_FILE, "w") as f:
        json.dump(payload, f, separators=(",", ":"))
    print(f"Wrote {config.APOL1_FILE}: {len(rows)} table rows, "
          f"{len(nodes)} nodes, {len(edge_rows)} edges")


if __name__ == "__main__":
    main()
