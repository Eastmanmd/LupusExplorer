"""Fetch every PMID matching the lupus query.

E-utilities caps retstart+retmax at 10,000 per query, so we slice the corpus
by publication year (no single year approaches that limit) and merge.
"""
import datetime
import time

import requests

import config

FIRST_YEAR = 1900


def esearch(session, term, retmax=9999):
    for attempt in range(5):
        try:
            r = session.get(
                f"{config.EUTILS_BASE}/esearch.fcgi",
                params={"db": "pubmed", "term": term, "retmax": retmax,
                        "retmode": "json"},
                timeout=60,
            )
            r.raise_for_status()
            return r.json()["esearchresult"]
        except Exception as e:
            wait = 2 ** attempt
            print(f"  retry {attempt + 1}: {e} (sleeping {wait}s)", flush=True)
            time.sleep(wait)
    raise RuntimeError(f"esearch failed for: {term}")


def main():
    session = requests.Session()
    this_year = datetime.date.today().year
    total = int(esearch(session, config.PUBMED_QUERY, retmax=0)["count"])
    print(f"Query matches {total} articles; slicing by year", flush=True)

    pmids = []
    seen = set()
    for year in range(FIRST_YEAR, this_year + 2):
        term = f'({config.PUBMED_QUERY}) AND ("{year}"[PDAT])'
        result = esearch(session, term)
        count = int(result["count"])
        ids = result["idlist"]
        if count > len(ids):
            # Year overflowed the 9,999 cap — split into months
            print(f"  {year}: {count} > cap, slicing by month", flush=True)
            ids = []
            for month in range(1, 13):
                mterm = (f'({config.PUBMED_QUERY}) AND '
                         f'("{year}/{month:02d}"[PDAT])')
                ids.extend(esearch(session, mterm)["idlist"])
                time.sleep(config.EUTILS_DELAY)
        new = [p for p in ids if p not in seen]
        seen.update(new)
        pmids.extend(new)
        if count:
            print(f"  {year}: +{len(new)} (running total {len(pmids)})", flush=True)
        time.sleep(config.EUTILS_DELAY)

    # Articles with no PDAT year land outside every slice; grab strays via a
    # final unsliced query for whatever fits under the cap.
    result = esearch(session, config.PUBMED_QUERY)
    strays = [p for p in result["idlist"] if p not in seen]
    pmids.extend(strays)
    print(f"  strays from unsliced query: +{len(strays)}", flush=True)

    with open(config.PMIDS_FILE, "w") as f:
        f.write("\n".join(pmids))
    print(f"Wrote {len(pmids)} unique PMIDs to {config.PMIDS_FILE} "
          f"(expected ~{total})", flush=True)


if __name__ == "__main__":
    main()
