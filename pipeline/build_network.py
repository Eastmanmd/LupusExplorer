"""Which genes the lupus literature talks about together.

Built from cache/mentions.jsonl and nothing else. Every edge exists because
PubTator found two genes in the same abstract; the weight is how many abstracts;
the modules come from the edges. No interaction database, no pathway membership,
no Open Targets. The node set is the top N genes by lupus paper count rather
than by the leaderboard score, because that score is 30% Open Targets and a map
billed as pure co-mention should not have its membership picked by a curated
database.

Two statistics, for the same reason build_emerging.py uses two. Raw co-mention
count is what gets *displayed* — it is the honest, legible number — but it is a
bad way to *choose* edges, because the most-published genes co-occur constantly
with each other whatever the biology: IL6-TNF is the 2nd heaviest pair in the
corpus and says nothing. So each pair is gated on a hypergeometric tail
probability (is this more overlap than chance?) and then selected and ranked on
normalized pointwise mutual information (how much more?). npmi is bounded in
-1..1 and its denominator discounts rare pairs, so it neither rewards fame like
the raw count nor blows up on a 4-of-4 coincidence like a bare lift ratio.

A global weight threshold turns out to be the wrong knob: past about 15
co-mentions the graph stops getting sparser and just loses genes, because the
degree distribution is heavy-tailed. Instead each gene keeps its k strongest
edges and the union is the graph — every gene stays on the map, no hub swallows
it, and k is one intuitive slider.

Outputs data/network.json: nodes with precomputed layout coordinates, an
index-based edge list, named modules, and ego neighbourhoods for off-map genes.
"""
import itertools
import json
import math
import os
import random
from collections import Counter, defaultdict

import requests

import config
from build_data import fetch_gene_info, load_mentions, merge_homologs


def logC(n, k):
    return math.lgamma(n + 1) - math.lgamma(k + 1) - math.lgamma(n - k + 1)


def log_hypergeom_sf(c, na, nb, total):
    """log P(X >= c) for X ~ Hypergeometric(total, na, nb).

    Summed forward from c by the term ratio rather than by re-entering lgamma
    for every term: the mode sits at na*nb/total, far below c for any pair worth
    testing, so the terms decay geometrically and this exits in a few passes.
    """
    hi = min(na, nb)
    if c > hi:
        return -math.inf
    if nb - c > total - na:
        return -math.inf
    log_first = logC(na, c) + logC(total - na, nb - c) - logC(total, nb)
    ratio_sum, term = 1.0, 1.0
    for i in range(c, hi):
        denom = total - na - nb + i + 1
        if denom <= 0:
            break
        term *= ((na - i) / (i + 1)) * ((nb - i) / denom)
        ratio_sum += term
        if term < 1e-14 * ratio_sum:
            break
    return log_first + math.log(ratio_sum)


def _local_move(graph, order):
    """One Louvain pass: move each node to whichever neighbouring community
    gives the largest modularity gain, until nothing moves."""
    strength = {n: sum(graph[n].values()) for n in graph}
    self_loops = {n: graph[n].get(n, 0.0) for n in graph}
    m2 = sum(strength.values())          # 2m
    if m2 <= 0:
        return {n: i for i, n in enumerate(order)}
    community = {n: i for i, n in enumerate(order)}
    total = dict(zip(range(len(order)), (strength[n] for n in order)))
    for _ in range(30):
        moved = 0
        for node in order:
            own = community[node]
            k = strength[node]
            total[own] -= k
            weights = defaultdict(float)
            for nbr, w in graph[node].items():
                if nbr != node:
                    weights[community[nbr]] += w
            best, best_gain = own, weights.get(own, 0.0) - total[own] * k / m2
            for cand, w in weights.items():
                gain = w - total[cand] * k / m2
                # Ties break on the lower community id so the partition does not
                # depend on dict order.
                if gain > best_gain + 1e-12 or (gain > best_gain - 1e-12 and cand < best):
                    best, best_gain = cand, gain
            total[best] = total.get(best, 0.0) + k
            if best != own:
                community[node] = best
                moved += 1
        if not moved:
            break
    return community


def louvain(adjacency, seed):
    """Communities by modularity optimisation, with aggregation.

    Label propagation was the cheaper option and it fragmented: 41 communities
    over 287 genes, 146 of them in communities of seven or fewer, which leaves a
    map that is mostly uncoloured. Louvain merges those into a handful of
    modules big enough to name and to give a legend entry to.

    Deterministic: node visit order is a seeded shuffle of a sorted list and
    modularity ties break on the lower community id.
    """
    rng = random.Random(seed)
    graph = {n: dict(nbrs) for n, nbrs in adjacency.items()}
    members = {n: [n] for n in graph}
    while True:
        order = sorted(graph)
        rng.shuffle(order)
        community = _local_move(graph, order)
        groups = defaultdict(list)
        for node, comm in community.items():
            groups[comm].append(node)
        if len(groups) == len(graph):
            break
        merged, new_graph = {}, defaultdict(lambda: defaultdict(float))
        for comm, nodes in groups.items():
            key = min(nodes)
            merged[key] = [g for n in nodes for g in members[n]]
            for node in nodes:
                for nbr, w in graph[node].items():
                    new_graph[key][nbr] += w
        # Re-point edges at the merged representatives.
        rep = {n: min(groups[community[n]]) for n in graph}
        collapsed = defaultdict(lambda: defaultdict(float))
        for key, nbrs in new_graph.items():
            for nbr, w in nbrs.items():
                collapsed[key][rep[nbr]] += w
        graph = {k: dict(v) for k, v in collapsed.items()}
        members = merged
    return sorted((sorted(m) for m in members.values()),
                  key=lambda m: (-len(m), m[0]))


# KEGG's 05xxx block is Human Diseases ("Breast cancer", "Malaria") and its
# 01xxx block is global maps and antineoplastic drug resistance ("Platinum drug
# resistance"). Any module of shared kinases or apoptosis genes hits several of
# them, and on a lupus site a module captioned "Breast cancer" reads as a claim
# rather than as the shared-kinase artefact it is.
KEGG_EXCLUDED_PREFIXES = ("KEGG:05", "KEGG:01")
# Reactome carries a disease branch whose ids look like any other, so it has to
# be filtered on the name: "MyD88 deficiency (TLR2/4)" is a real annotation of
# the TLR genes, but as a caption on a lupus map it reads as a claim about
# lupus. Dropping these lets the mechanism term underneath surface instead.
PATHOLOGY_WORDS = ("deficiency", "disease", "cancer", "carcinoma", "tumor",
                   "tumour", "infection", "syndrome", "leukemia", "melanoma")


def pick_label(results):
    """The most specific term that still covers the module.

    g:Profiler orders by p-value, which rewards enormous parent terms — a T-cell
    module's best hit is "immune system process", which tells a reader nothing.
    Among the terms covering at least half as many module genes as the best one
    does, take the smallest, so the caption is the term someone would recognise.
    """
    usable = [r for r in results
              if not r["native"].startswith(KEGG_EXCLUDED_PREFIXES)
              and not any(w in r["name"].lower() for w in PATHOLOGY_WORDS)]
    if not usable:
        return None
    floor = max(r["intersection_size"] for r in usable) * 0.5
    covering = [r for r in usable if r["intersection_size"] >= floor]
    return min(covering, key=lambda r: (r["term_size"], r["p_value"], r["native"]))


def query_gprofiler(query, background=None):
    body = {
        "organism": "hsapiens",
        "query": query,
        "sources": ["GO:BP", "KEGG", "REAC"],
        "user_threshold": 0.05,
        "significance_threshold_method": "g_SCS",
        "no_evidences": True,
    }
    if background:
        body["domain_scope"] = "custom"
        body["background"] = sorted(background)
    r = requests.post(config.GPROFILER_URL, json=body, timeout=300)
    r.raise_for_status()
    grouped = defaultdict(list)
    for res in r.json()["result"]:
        grouped[res["query"]].append(res)
    return grouped


def name_modules(modules, background, cache_file=None):
    """Ask g:Profiler what each module is, in two multi-query requests.

    The first uses the network's own gene set as the background, not the genome.
    Against a genome background every module in a set of lupus genes enriches
    for "immune system process" and the labels carry no information; against the
    other 299 genes a module is only labelled for what makes it *different from
    the rest of the map*, which is the interesting question.

    That test is strict enough to leave the most recognisable modules unnamed —
    a set of T-cell markers is not differentially enriched among 300 immune
    genes — so a second pass against the genome supplies a fallback name. Which
    scope produced a label is recorded, because they mean different things.
    Modules that neither pass names keep none: usually the literature groups
    them for a reason curation does not encode (an antibody panel, a GWAS locus,
    a clinical syndrome), and inventing a caption would hide that.

    Cached, because this is the one network step that leaves the machine.
    """
    cache_file = cache_file or config.NETWORK_MODULES_FILE
    query = {f"m{i}": m for i, m in enumerate(modules) if len(m) >= 3}
    if not query:
        return {}
    if os.path.exists(cache_file):
        with open(cache_file) as f:
            cache = json.load(f)
        if cache.get("query") == query:
            print(f"  module labels: cached ({len(cache['labels'])} named)")
            return cache["labels"]
    print(f"  module labels: asking g:Profiler about {len(query)} modules")
    against_map = query_gprofiler(query, background=background)
    against_genome = query_gprofiler(query)
    labels = {}
    for key in query:
        for scope, grouped in (("map", against_map), ("genome", against_genome)):
            best = pick_label(grouped.get(key, []))
            if best:
                labels[key] = {"term": best["name"], "term_id": best["native"],
                               "source": best["source"], "p": best["p_value"],
                               "hits": best["intersection_size"],
                               "term_size": best["term_size"], "scope": scope}
                break
    with open(cache_file, "w") as f:
        json.dump({"query": query, "labels": labels}, f)
    return labels


def layout(symbols, edges, modules, width=1000, height=680,
           iterations=None, seed=None):
    """Seeded spring-and-charge layout, so every visitor sees the same map.

    Precomputed here rather than simulated in the browser: a layout that
    reshuffles on every visit cannot be learned, and the site ships no physics
    library.

    Springs pull each edge toward a rest length rather than with a force that
    grows without bound in the distance. Textbook Fruchterman-Reingold uses
    d^2/k attraction, and on a graph this size that overwhelms the repulsion in
    the first few steps and folds all 287 nodes into a corner. A rest-length
    spring cannot: once an edge is at its target it stops pulling.

    Nodes start grouped by module around a circle, which converges faster and
    keeps a module from being torn in half by an unlucky start.
    """
    iterations = iterations or config.NETWORK_LAYOUT_ITERATIONS
    rng = random.Random(seed or config.NETWORK_LAYOUT_SEED)
    n = len(symbols)
    if n == 0:
        return [], (width, height)
    index = {s: i for i, s in enumerate(symbols)}
    module_of = {}
    for m, members in enumerate(modules):
        for s in members:
            module_of[s] = m

    rest = math.sqrt(width * height / max(1, n)) * 0.62
    repulsion = rest * rest * 1.6
    spring, centring, velocity_decay = 0.22, 0.012, 0.62
    # A weak pull toward each module's own centre of mass, on top of the edges.
    # Without it the peripheral modules (complement, coagulation, splicing) come
    # out coherent but the immune core does not: those modules genuinely
    # interconnect, so edge forces alone interleave them into one hairball and
    # the colours stop meaning anything. At this strength the edges still decide
    # the global arrangement; this only stops members of one module from being
    # scattered through another. Proximity therefore reflects module membership
    # as well as co-mention, which is what the captions claim it does.
    cohesion = 0.05

    xs, ys, vxs, vys = [], [], [0.0] * n, [0.0] * n
    ring = max(1, len(modules) + 1)
    for s in symbols:
        angle = 2 * math.pi * module_of.get(s, len(modules)) / ring
        xs.append(math.cos(angle) * 300 + rng.uniform(-60, 60))
        ys.append(math.sin(angle) * 300 + rng.uniform(-60, 60))
    links = [(index[a], index[b], w) for a, b, w in edges]

    for step in range(iterations):
        alpha = max(0.02, 1.0 - step / iterations)
        for i in range(n):
            xi, yi, ax, ay = xs[i], ys[i], 0.0, 0.0
            for j in range(i + 1, n):
                dx, dy = xs[j] - xi, ys[j] - yi
                d2 = dx * dx + dy * dy
                if d2 < 1e-6:
                    dx, dy = rng.uniform(-1, 1), rng.uniform(-1, 1)
                    d2 = dx * dx + dy * dy
                d = math.sqrt(d2)
                push = repulsion / d2 / d
                ax -= dx * push
                ay -= dy * push
                vxs[j] += dx * push
                vys[j] += dy * push
            vxs[i] += ax
            vys[i] += ay
        for i, j, w in links:
            dx, dy = xs[j] - xs[i], ys[j] - ys[i]
            d = math.sqrt(dx * dx + dy * dy) or 1e-3
            pull = (d - rest) * spring * w / d
            vxs[i] += dx * pull
            vys[i] += dy * pull
            vxs[j] -= dx * pull
            vys[j] -= dy * pull
        if cohesion:
            sums = defaultdict(lambda: [0.0, 0.0, 0])
            for i, sym in enumerate(symbols):
                acc = sums[module_of.get(sym, -1)]
                acc[0] += xs[i]
                acc[1] += ys[i]
                acc[2] += 1
            for i, sym in enumerate(symbols):
                cx, cy, count = sums[module_of.get(sym, -1)]
                if count < 3:
                    continue
                vxs[i] += (cx / count - xs[i]) * cohesion
                vys[i] += (cy / count - ys[i]) * cohesion
        for i in range(n):
            vxs[i] = (vxs[i] - xs[i] * centring) * velocity_decay
            vys[i] = (vys[i] - ys[i] * centring) * velocity_decay
            xs[i] += vxs[i] * alpha
            ys[i] += vys[i] * alpha

    # Scale uniformly — distances in a force layout carry meaning, so the two
    # axes cannot be stretched independently — and then trim the viewBox to what
    # the layout settled into rather than letterboxing it in a fixed rectangle.
    #
    # Fit on the 2nd-98th percentile rather than the extremes. A handful of
    # pendant genes hang off the graph on a single long edge, and fitting to
    # them squeezes the other 280 into two thirds of the canvas. They are
    # clamped to the border instead, which is where they belong anyway.
    def span(values):
        ordered = sorted(values)
        lo = ordered[int(0.02 * (len(ordered) - 1))]
        hi = ordered[int(0.98 * (len(ordered) - 1))]
        return lo, (hi - lo) or 1.0

    pad = 26
    x0, spanx = span(xs)
    y0, spany = span(ys)
    scale = min((width - 2 * pad) / spanx, (height - 2 * pad) / spany)
    box_w = round(spanx * scale + 2 * pad)
    box_h = round(spany * scale + 2 * pad)
    clamp = lambda v, hi: round(min(max(v, pad), hi - pad), 1)
    coords = [[clamp((xs[i] - x0) * scale + pad, box_w),
               clamp((ys[i] - y0) * scale + pad, box_h)] for i in range(n)]
    return coords, (box_w, box_h)


def main():
    articles, gene_articles = load_mentions()
    candidates = {g: p for g, p in gene_articles.items()
                  if len(p) >= config.MIN_PAPERS_FOR_CANDIDATE}
    info = fetch_gene_info(sorted(candidates))
    groups = merge_homologs(candidates, info)

    # Alias collisions have to be dropped here too. Left in, CD19-NR1I3 is the
    # single newest strong edge on the map, and it is entirely an artefact of
    # PubTator resolving "CAR" in CAR-T papers onto the androstane receptor.
    for symbol in config.ALIAS_COLLISIONS:
        groups.pop(symbol.upper(), None)

    papers_of = {s: len(g["pmids"]) for s, g in groups.items()}
    ranked = sorted(papers_of, key=lambda s: (-papers_of[s], s))
    nodes = ranked[: config.NETWORK_NODES]
    node_set = set(nodes)
    corpus = len(articles)
    print(f"{len(groups)} genes, {corpus} articles; network on the top "
          f"{len(nodes)} by paper count (>= {papers_of[nodes[-1]]} papers)")

    # Co-mentions. One pass over papers rather than per-pair lookups; broad
    # surveys are skipped because a 45-gene paper alone contributes 990 pairs.
    gene_of_paper = defaultdict(set)
    for symbol in groups:
        for pmid in groups[symbol]["pmids"]:
            gene_of_paper[pmid].add(symbol)
    complete_year = max(a["year"] for a in articles.values() if a["year"])
    recent_from = complete_year - config.RECENT_YEARS
    co, co_recent, ego = Counter(), Counter(), Counter()
    for pmid, symbols in gene_of_paper.items():
        if len(symbols) < 2 or len(symbols) > config.NETWORK_MAX_PAPER_GENES:
            continue
        year = articles[pmid]["year"] or 0
        on_map = sorted(symbols & node_set)
        for pair in itertools.combinations(on_map, 2):
            co[pair] += 1
            if year >= recent_from:
                co_recent[pair] += 1
        for off in symbols - node_set:
            for partner in on_map:
                ego[(off, partner)] += 1

    # Gate on significance, select on effect size.
    ln_threshold = math.log(config.NETWORK_P_THRESHOLD)
    scored = []
    for (a, b), count in co.items():
        if count < config.NETWORK_MIN_CO:
            continue
        na, nb = papers_of[a], papers_of[b]
        p_joint = count / corpus
        npmi = math.log(p_joint / ((na / corpus) * (nb / corpus))) / -math.log(p_joint)
        log_p = log_hypergeom_sf(count, na, nb, corpus)
        if log_p >= ln_threshold:
            continue
        scored.append({"a": a, "b": b, "co": count, "npmi": round(npmi, 3),
                       "lift": round(count / (na * nb / corpus), 1),
                       "recent": round(co_recent[(a, b)] / count, 3)})
    print(f"  {len(co)} co-mentioned pairs, {len(scored)} significant at "
          f"p < {config.NETWORK_P_THRESHOLD}")

    # Backbone: the union of each gene's strongest k edges.
    by_gene = defaultdict(list)
    for e in scored:
        by_gene[e["a"]].append(e)
        by_gene[e["b"]].append(e)
    keep = set()
    for gene, gene_edges in by_gene.items():
        gene_edges.sort(key=lambda e: (-e["npmi"], e["a"], e["b"]))
        for e in gene_edges[: config.NETWORK_EDGES_PER_NODE]:
            keep.add((e["a"], e["b"]))
    edges = sorted((e for e in scored if (e["a"], e["b"]) in keep),
                   key=lambda e: (-e["npmi"], e["a"], e["b"]))
    connected = {x for e in edges for x in (e["a"], e["b"])}
    isolated = sorted(node_set - connected)
    print(f"  backbone: {len(edges)} edges over {len(connected)} genes, "
          f"{len(isolated)} with no edge above the threshold")

    adjacency = defaultdict(dict)
    for e in edges:
        adjacency[e["a"]][e["b"]] = e["npmi"]
        adjacency[e["b"]][e["a"]] = e["npmi"]
    modules = louvain(adjacency, config.NETWORK_LAYOUT_SEED)
    labels = name_modules(modules, node_set)
    sizes = [len(m) for m in modules[:12]]
    print(f"  {len(modules)} modules, largest {sizes}")

    # Layout runs over the connected genes only — isolated ones are listed
    # beside the map rather than floated as unattached dots — but they stay in
    # the node list, because an isolated gene is still a legitimate ego partner
    # and still has a page worth opening.
    plotted = sorted(connected)
    coords, (box_w, box_h) = layout(
        plotted, [(e["a"], e["b"], e["npmi"]) for e in edges], modules)
    xy = dict(zip(plotted, coords))
    listed = plotted + isolated

    module_of, module_rows = {}, []
    for i, members in enumerate(modules):
        info_row = labels.get(f"m{i}")
        for s in members:
            module_of[s] = i
        module_rows.append({
            "id": i, "size": len(members),
            "coloured": (i < config.NETWORK_PALETTE_SIZE
                         and len(members) >= config.NETWORK_MIN_COLOURED_SIZE),
            "label": (info_row or {}).get("term"),
            "term_id": (info_row or {}).get("term_id"),
            "source": (info_row or {}).get("source"),
            "p": (info_row or {}).get("p"),
            "hits": (info_row or {}).get("hits"),
            "scope": (info_row or {}).get("scope"),
            "genes": members,
        })

    drugs = {}
    if os.path.exists(config.DRUGS_FILE):
        with open(config.DRUGS_FILE) as f:
            drugs = json.load(f)
    lit_rank, emerging_rank = {}, {}
    pool_path = os.path.join(config.DATA_DIR, "pool.json")
    if os.path.exists(pool_path):
        with open(pool_path) as f:
            lit_rank = {g["symbol"]: g["rank"] for g in json.load(f)["pool"]}
    if os.path.exists(config.EMERGING_FILE):
        with open(config.EMERGING_FILE) as f:
            emerging_rank = {g["symbol"]: g["rank"] for g in json.load(f)["genes"]}

    node_rows = []
    for symbol in listed:
        drug = drugs.get(symbol, {})
        node_rows.append({
            "symbol": symbol,
            "name": (info[groups[symbol]["human"]] or {}).get("name", ""),
            "entrez": groups[symbol]["human"],
            "papers": papers_of[symbol],
            "degree": len(adjacency[symbol]),
            "module": module_of.get(symbol),
            "x": xy[symbol][0] if symbol in xy else None,
            "y": xy[symbol][1] if symbol in xy else None,
            "drug_stage": drug.get("top_stage"),
            "drugs": drug.get("drugs", []),
            "lit_rank": lit_rank.get(symbol),
            "emerging_rank": emerging_rank.get(symbol),
        })
    order = {s: i for i, s in enumerate(listed)}
    edge_rows = [[order[e["a"]], order[e["b"]], e["co"], e["npmi"], e["recent"]]
                 for e in edges]

    # Ego neighbourhoods for genes off the map. A gene with 19 lupus papers has
    # no place in a 300-node picture, but "EXT1 sits next to PLA2R1" is exactly
    # what someone arriving from the emerging tab wants to know.
    ego_by_gene = defaultdict(list)
    for (off, partner), count in ego.items():
        if count >= config.NETWORK_EGO_MIN_CO:
            ego_by_gene[off].append([order[partner], count])
    # Sorted, because `ego` was accumulated by iterating sets: without it the
    # key order of this map churns between otherwise identical runs.
    neighbours = {}
    for off in sorted(ego_by_gene):
        partners = ego_by_gene[off]
        if len(partners) < config.NETWORK_EGO_MIN_PARTNERS:
            continue
        partners.sort(key=lambda p: (-p[1], p[0]))
        neighbours[off] = {"papers": papers_of[off], "partners": partners[:12]}
    print(f"  {len(neighbours)} off-map genes with an ego neighbourhood")

    payload = {
        "nodes": node_rows,
        "edges": edge_rows,
        "modules": module_rows,
        "isolated": isolated,
        "neighbours": neighbours,
        "corpus_articles": corpus,
        "paper_floor": papers_of[nodes[-1]],
        "min_co": config.NETWORK_MIN_CO,
        "ego_min_co": config.NETWORK_EGO_MIN_CO,
        "p_threshold": config.NETWORK_P_THRESHOLD,
        "edges_per_node": config.NETWORK_EDGES_PER_NODE,
        "max_paper_genes": config.NETWORK_MAX_PAPER_GENES,
        "recent_from": recent_from,
        "complete_year": complete_year,
        "min_coloured_size": config.NETWORK_MIN_COLOURED_SIZE,
        "excluded": sorted(config.ALIAS_COLLISIONS),
        "width": box_w, "height": box_h,
    }
    os.makedirs(config.DATA_DIR, exist_ok=True)
    with open(config.NETWORK_FILE, "w") as f:
        json.dump(payload, f)
    named = sum(1 for m in module_rows if m["label"])
    print(f"Wrote {len(node_rows)} nodes and {len(edge_rows)} edges to "
          f"{config.NETWORK_FILE} ({named} modules named)")
    for m in module_rows[:8]:
        print(f"  m{m['id']} ({m['size']}): {m['label'] or 'unnamed'} — "
              + ", ".join(m["genes"][:8]))


if __name__ == "__main__":
    main()
