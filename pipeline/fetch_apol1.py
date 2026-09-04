"""Fetch the APOL1 literature and its PubTator gene annotations.

A second, small corpus alongside the lupus one. It exists because the lupus
corpus cannot support the APOL1 tab on its own: PubTator finds APOL1 in 40
lupus papers, 28 of which name APOL1 and no other gene, so co-mention structure
restricted to the intersection is two abstracts wide. The full APOL1 literature
(~1,300 papers) supplies partners; build_apol1.py labels every one of them by
whether the lupus corpus has met it, which is what the tab's two rings show.

Writes cache/apol1_mentions.jsonl in exactly the format fetch_pubtator.py uses,
and is resumable the same way. Papers already annotated in cache/mentions.jsonl
are copied across rather than re-requested, so the overlap costs nothing.

Deliberately does not touch cache/mentions.jsonl: that file is a 30-45 minute
fetch and nothing here has any business writing to it.
"""
import json
import os
import time

import requests

import config
from fetch_pmids import esearch
from fetch_pubtator import fetch_batch, parse_document


def load_done(path):
    done = set()
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                try:
                    done.add(json.loads(line)["pmid"])
                except Exception:
                    continue
    return done


def load_lupus_records():
    """PMID -> record, for papers the main corpus already annotated."""
    records = {}
    if not os.path.exists(config.MENTIONS_FILE):
        return records
    with open(config.MENTIONS_FILE) as f:
        for line in f:
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            pmid = rec.get("pmid")
            if pmid and not rec.get("missing"):
                records[pmid] = rec
    return records


def main():
    session = requests.Session()

    # One esearch: the APOL1 literature is ~1.3k papers, nowhere near the
    # 10,000 retstart cap that forces fetch_pmids.py to slice by year.
    result = esearch(session, config.APOL1_QUERY)
    pmids = result["idlist"]
    count = int(result["count"])
    if count > len(pmids):
        raise RuntimeError(
            f"APOL1 query returned {count} > {len(pmids)} fetched — the corpus has "
            "outgrown a single esearch page; slice it by year like fetch_pmids.py")
    with open(config.APOL1_PMIDS_FILE, "w") as f:
        f.write("\n".join(pmids))
    print(f"APOL1 corpus: {len(pmids)} PMIDs", flush=True)

    done = load_done(config.APOL1_MENTIONS_FILE)
    lupus = load_lupus_records()
    out = open(config.APOL1_MENTIONS_FILE, "a")

    # Free ride on the main corpus for anything it already annotated.
    reused = 0
    for pmid in pmids:
        if pmid in done or pmid not in lupus:
            continue
        rec = dict(lupus[pmid])
        rec["lupus"] = True
        out.write(json.dumps(rec) + "\n")
        done.add(pmid)
        reused += 1
    out.flush()

    todo = [p for p in pmids if p not in done]
    print(f"  {reused} reused from the lupus corpus, {len(todo)} to fetch", flush=True)

    t0 = time.time()
    for i in range(0, len(todo), config.PUBTATOR_BATCH):
        batch = todo[i : i + config.PUBTATOR_BATCH]
        docs = fetch_batch(session, batch)
        if docs is None:
            continue  # logged by fetch_batch; resumable on the next run
        returned = set()
        for doc in docs:
            rec = parse_document(doc)
            if not rec["pmid"]:
                continue
            returned.add(rec["pmid"])
            rec["lupus"] = False   # membership is decided by the lupus PMID set,
            out.write(json.dumps(rec) + "\n")   # not by this file
        for pmid in batch:
            if pmid not in returned:
                out.write(json.dumps({"pmid": pmid, "year": None, "journal": "",
                                      "title": "", "genes": [], "missing": True}) + "\n")
        out.flush()
        print(f"  {min(i + len(batch), len(todo))}/{len(todo)} "
              f"({time.time() - t0:.0f}s)", flush=True)
        time.sleep(config.PUBTATOR_DELAY)
    out.close()
    print("Done.", flush=True)


if __name__ == "__main__":
    main()
