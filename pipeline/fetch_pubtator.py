"""Fetch gene annotations for every lupus PMID from PubTator 3.

Writes one JSON line per article to cache/mentions.jsonl:
    {"pmid": "123", "year": 2021, "journal": "...", "title": "...", "genes": ["3458", ...]}

Resumable: already-processed PMIDs (present in the output file) are skipped,
so the script can be re-run after an interruption or on a later week to pick
up only new articles.
"""
import json
import os
import re
import time

import requests

import config

YEAR_RE = re.compile(r"\b(19[0-9]{2}|20[0-9]{2})\b")


def load_done():
    done = set()
    if os.path.exists(config.MENTIONS_FILE):
        with open(config.MENTIONS_FILE) as f:
            for line in f:
                try:
                    done.add(json.loads(line)["pmid"])
                except Exception:
                    continue
    return done


def parse_document(doc):
    pmid = str(doc.get("pmid") or doc.get("id", ""))
    title = ""
    journal = doc.get("journal") or ""
    year = None
    date = doc.get("date") or ""
    m = YEAR_RE.match(str(date))
    if m:
        year = int(m.group(1))
    genes = set()
    for passage in doc.get("passages", []):
        infons = passage.get("infons", {})
        ptype = infons.get("type", "").lower()
        section = infons.get("section_type", "").lower()
        if not title and (ptype in ("title", "front") or section == "title"):
            title = passage.get("text", "")
        if not journal:
            journal = infons.get("journal", "") or ""
        if year is None:
            y = infons.get("year")
            if y and str(y).isdigit():
                year = int(y)
            elif journal:
                m = YEAR_RE.search(journal)
                if m:
                    year = int(m.group(1))
        for ann in passage.get("annotations", []):
            ainfons = ann.get("infons", {})
            if ainfons.get("type") != "Gene":
                continue
            identifier = ainfons.get("identifier") or ainfons.get("Identifier")
            if not identifier or identifier == "-":
                continue
            # identifier can be "3458" or "3458;7124"
            for gid in str(identifier).split(";"):
                gid = gid.strip()
                if gid.isdigit():
                    genes.add(gid)
    # Passage-infons journal strings look like "Lupus. 2021 Mar;30(3):..." — keep
    # the name only; the clean top-level field has no citation tail to strip.
    journal_name = journal.split(". ")[0].strip() if YEAR_RE.search(journal) else journal.strip()
    return {
        "pmid": pmid,
        "year": year,
        "journal": journal_name,
        "title": title,
        "genes": sorted(genes),
    }


def fetch_batch(session, pmids):
    for attempt in range(6):
        try:
            r = session.get(
                config.PUBTATOR_EXPORT,
                params={"pmids": ",".join(pmids)},
                timeout=120,
            )
            if r.status_code == 429 or r.status_code >= 500:
                raise RuntimeError(f"HTTP {r.status_code}")
            r.raise_for_status()
            text = r.text.strip()
            if not text:
                return []
            docs = []
            try:
                payload = json.loads(text)
                if isinstance(payload, dict):
                    docs = payload.get("PubTator3", []) or payload.get("documents", [])
                elif isinstance(payload, list):
                    docs = payload
            except json.JSONDecodeError:
                # newline-delimited BioC JSON
                for line in text.splitlines():
                    line = line.strip()
                    if line:
                        docs.append(json.loads(line))
            return docs
        except Exception as e:
            wait = min(2 ** attempt, 30)
            print(f"  batch retry {attempt + 1}: {e} (sleeping {wait}s)", flush=True)
            time.sleep(wait)
    print(f"  WARNING: giving up on batch starting {pmids[0]}", flush=True)
    return None


def main():
    with open(config.PMIDS_FILE) as f:
        all_pmids = [line.strip() for line in f if line.strip()]
    done = load_done()
    todo = [p for p in all_pmids if p not in done]
    print(f"{len(all_pmids)} PMIDs total, {len(done)} already done, {len(todo)} to fetch", flush=True)

    session = requests.Session()
    out = open(config.MENTIONS_FILE, "a")
    processed = 0
    t0 = time.time()
    for i in range(0, len(todo), config.PUBTATOR_BATCH):
        batch = todo[i : i + config.PUBTATOR_BATCH]
        docs = fetch_batch(session, batch)
        if docs is None:
            continue  # logged; move on, resumable later
        returned = set()
        for doc in docs:
            rec = parse_document(doc)
            if not rec["pmid"]:
                continue
            returned.add(rec["pmid"])
            out.write(json.dumps(rec) + "\n")
        # Articles PubTator has no record for: write a stub so we don't re-request forever
        for pmid in batch:
            if pmid not in returned:
                out.write(json.dumps({"pmid": pmid, "year": None, "journal": "",
                                      "title": "", "genes": [], "missing": True}) + "\n")
        out.flush()
        processed += len(batch)
        if processed % 2000 < config.PUBTATOR_BATCH:
            rate = processed / max(time.time() - t0, 1)
            eta_min = (len(todo) - processed) / max(rate, 0.1) / 60
            print(f"  {processed}/{len(todo)} ({rate:.0f}/s, ~{eta_min:.0f} min left)", flush=True)
        time.sleep(config.PUBTATOR_DELAY)
    out.close()
    print("Done.", flush=True)


if __name__ == "__main__":
    main()
