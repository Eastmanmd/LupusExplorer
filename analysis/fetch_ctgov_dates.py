"""Replace hand-assigned first-in-SLE dates with ClinicalTrials.gov
first-posted dates.

For every drug attached to a candidate gene, find the earliest lupus trial on
the registry. The gene's entry year is the earliest across its drugs.

Writes analysis/out/ctgov_dates.json. Network reads only; touches nothing in
cache/ or data/.

CAVEAT: the registry opened in 2000 and only became mandatory for most trials
in 2005, so entry years before ~2005 are censored -- a drug in SLE trials in
1999 may first appear here in 2005 or not at all. Affects the pre-cutoff
exclusion set, not the post-cutoff positives, for cutoffs from 2010 on.
"""
import json, os, sys, time, urllib.parse, urllib.request
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)
CACHE = os.path.join(OUT, "ctgov_raw.json")

API = "https://clinicaltrials.gov/api/v2/studies"
DELAY = 0.35


def query(drug):
    params = {
        "query.cond": "lupus",
        "query.intr": drug,
        "fields": "NCTId,BriefTitle,StudyFirstPostDate,OverallStatus,Phase",
        "pageSize": "50",
    }
    url = API + "?" + urllib.parse.urlencode(params)
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=45) as r:
                return json.load(r).get("studies", [])
        except Exception as e:
            if attempt == 2:
                print(f"    ! {drug}: {e}", file=sys.stderr)
                return None
            time.sleep(2 * (attempt + 1))


def main():
    from build_holdout import DROP_DRUGS, MAX_GENES_PER_DRUG
    drugs_by_gene = json.load(open(os.path.join(ROOT, "cache", "drugs.json")))
    fanout = defaultdict(int)
    for sym, v in drugs_by_gene.items():
        for d in v.get("drugs", []):
            fanout[d["drug"]] += 1

    gene_drugs = {}
    for sym, v in drugs_by_gene.items():
        keep = sorted({d["drug"] for d in v.get("drugs", [])
                       if d["drug"] not in DROP_DRUGS
                       and fanout[d["drug"]] <= MAX_GENES_PER_DRUG})
        if keep:
            gene_drugs[sym] = keep
    all_drugs = sorted({d for ds in gene_drugs.values() for d in ds})

    raw = json.load(open(CACHE)) if os.path.exists(CACHE) else {}
    todo = [d for d in all_drugs if d not in raw]
    print(f"{len(gene_drugs)} genes, {len(all_drugs)} distinct drugs, "
          f"{len(todo)} to query")

    for i, drug in enumerate(todo, 1):
        studies = query(drug)
        if studies is None:
            continue
        hits = []
        for s in studies:
            ps = s.get("protocolSection", {})
            date = (ps.get("statusModule", {})
                      .get("studyFirstPostDateStruct", {}).get("date"))
            if not date:
                continue
            hits.append({
                "nct": ps.get("identificationModule", {}).get("nctId"),
                "title": ps.get("identificationModule", {}).get("briefTitle", ""),
                "first_posted": date,
                "phase": ",".join(ps.get("designModule", {}).get("phases", [])),
                "status": ps.get("statusModule", {}).get("overallStatus", ""),
            })
        hits.sort(key=lambda h: h["first_posted"])
        raw[drug] = hits
        if i % 10 == 0 or i == len(todo):
            json.dump(raw, open(CACHE, "w"), indent=1)
            print(f"  {i}/{len(todo)}")
        time.sleep(DELAY)
    json.dump(raw, open(CACHE, "w"), indent=1)

    entry = {}
    for sym, ds in gene_drugs.items():
        best = None
        for d in ds:
            for h in raw.get(d, []):
                y = int(h["first_posted"][:4])
                if best is None or y < best[0]:
                    best = (y, d, h["nct"], h["title"], h["phase"])
        if best:
            entry[sym] = {"year": best[0], "drug": best[1], "nct": best[2],
                          "title": best[3], "phase": best[4]}
    json.dump(entry, open(os.path.join(OUT, "ctgov_dates.json"), "w"), indent=1)

    print(f"\n{len(entry)} genes with a dated lupus trial "
          f"({len(gene_drugs)-len(entry)} with none)\n")
    for sym, e in sorted(entry.items(), key=lambda kv: kv[1]["year"]):
        print(f"  {e['year']}  {sym:<11} {e['drug']:<24} {e['nct']}  {e['phase']}")
    nohit = sorted(set(gene_drugs) - set(entry))
    if nohit:
        print(f"\nno registered lupus trial found: {', '.join(nohit)}")


if __name__ == "__main__":
    main()
