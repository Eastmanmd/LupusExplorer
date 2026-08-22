"""How lupus-specific is each gene's literature?

Raw mention counts reward genes that are famous everywhere — IL6 appears in
tens of thousands of papers across all of biology, so a lupus mention says
little about lupus. This fetches each gene's *total* PubMed footprint so the
scorer can compute lupus papers / total papers.

The subtlety is the denominator. PubTator found the lupus mentions by resolving
synonyms — "BAFF", "BLyS" and "TNFSF13B" all count as one gene — so a
denominator built from the approved symbol alone is far too small (TNFSF13B
has more lupus papers than papers literally containing "TNFSF13B"). Aliases
come from Entrez and go into the query, so numerator and denominator count the
same way.

Writes cache/specificity.json: {symbol: {total, aliases, query}}. Incremental.
"""
import json
import os
import re
import time

import requests

import config

# Gene aliases that are also ordinary English words; including them in a
# title/abstract query would badly inflate the denominator.
STOPWORDS = {
    "thank", "impact", "rest", "set", "max", "cat", "hair", "arts", "pigs",
    "star", "hand", "gift", "clock", "shape", "sand", "coil", "mask", "band",
    "camp", "care", "cast", "chip", "core", "cord", "damp", "fast", "flame",
    "gene", "grip", "heat", "help", "hope", "lamp", "lard", "lens", "mail",
    "mice", "mind", "nail", "note", "pace", "path", "peak", "pearl", "pest",
    "pain", "rack", "rage", "ring", "ship", "slam", "snap", "soul", "spot",
    "step", "tail", "tank", "tissue", "trap", "wave", "wing", "site", "part",
}
ALIAS_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9\-]{3,15}$")
BATCH = 200


def usable_aliases(raw):
    """Aliases specific enough to search on: no 3-letter codes, no words."""
    out = []
    for alias in (raw or "").split(","):
        alias = alias.strip()
        if not ALIAS_RE.match(alias) or alias.lower() in STOPWORDS:
            continue
        out.append(alias)
    return out[:8]


def fetch_aliases(session, entrez_ids):
    aliases = {}
    for i in range(0, len(entrez_ids), BATCH):
        batch = entrez_ids[i:i + BATCH]
        for attempt in range(4):
            try:
                r = session.post(f"{config.EUTILS_BASE}/esummary.fcgi",
                                 data={"db": "gene", "id": ",".join(batch),
                                       "retmode": "json"}, timeout=90)
                r.raise_for_status()
                result = r.json().get("result", {})
                break
            except Exception as e:
                print(f"  alias retry {attempt + 1}: {e}")
                time.sleep(2 ** attempt)
        else:
            raise RuntimeError("esummary failed while fetching aliases")
        for uid in result.get("uids", []):
            info = result[uid]
            aliases[info.get("name", "")] = usable_aliases(info.get("otheraliases"))
        time.sleep(config.EUTILS_DELAY)
    return aliases


def main():
    path = os.path.join(config.DATA_DIR, "genes.json")
    if not os.path.exists(path):
        raise SystemExit("data/genes.json missing — run build_data.py first")
    with open(path) as f:
        genes = [(g["symbol"], g["entrez"]) for g in json.load(f)["genes"]]

    cache = {}
    if os.path.exists(config.SPECIFICITY_FILE):
        with open(config.SPECIFICITY_FILE) as f:
            loaded = json.load(f)
        # Old versions of this cache stored a bare integer per symbol; those
        # counts were symbol-only and are not comparable, so drop them.
        cache = {k: v for k, v in loaded.items() if isinstance(v, dict)}

    todo = [(s, e) for s, e in genes if s not in cache]
    print(f"PubMed totals: {len(genes)} genes, {len(todo)} to fetch")
    if not todo:
        return

    session = requests.Session()
    aliases = fetch_aliases(session, [e for _, e in todo])
    print(f"  resolved aliases for {sum(1 for v in aliases.values() if v)} genes")

    for i, (symbol, _) in enumerate(todo, 1):
        terms = [symbol] + [a for a in aliases.get(symbol, []) if a != symbol]
        query = " OR ".join(f'"{t}"[tiab]' for t in terms)
        total = None
        for attempt in range(4):
            try:
                r = session.post(f"{config.EUTILS_BASE}/esearch.fcgi",
                                 data={"db": "pubmed", "term": query,
                                       "rettype": "count", "retmode": "json"},
                                 timeout=60)
                r.raise_for_status()
                total = int(r.json()["esearchresult"]["count"])
                break
            except Exception as e:
                print(f"  {symbol} retry {attempt + 1}: {e}")
                time.sleep(2 ** attempt)
        if total is None:
            print(f"  {symbol}: giving up, leaving uncached")
            continue
        cache[symbol] = {"total": total, "aliases": aliases.get(symbol, []),
                         "query": query}
        if i % 25 == 0 or i == len(todo):
            print(f"  {i}/{len(todo)}")
            with open(config.SPECIFICITY_FILE, "w") as f:
                json.dump(cache, f)
        time.sleep(config.EUTILS_DELAY)

    with open(config.SPECIFICITY_FILE, "w") as f:
        json.dump(cache, f)
    print(f"Wrote PubMed totals for {len(cache)} genes to {config.SPECIFICITY_FILE}")


if __name__ == "__main__":
    main()
