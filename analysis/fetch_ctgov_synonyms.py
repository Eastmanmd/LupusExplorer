"""Second CT.gov pass: query development codes as well as INNs, and merge."""
import json, os, time
from fetch_ctgov_dates import query, CACHE, OUT
from drug_synonyms import SYNONYMS

raw = json.load(open(CACHE))
updated = 0
for inn, codes in SYNONYMS.items():
    for code in codes:
        key = f"{inn}||{code}"
        if key in raw:
            continue
        studies = query(code)
        hits = []
        for s in (studies or []):
            ps = s.get("protocolSection", {})
            date = (ps.get("statusModule", {})
                      .get("studyFirstPostDateStruct", {}).get("date"))
            if not date:
                continue
            hits.append({"nct": ps.get("identificationModule", {}).get("nctId"),
                         "title": ps.get("identificationModule", {}).get("briefTitle", ""),
                         "first_posted": date,
                         "phase": ",".join(ps.get("designModule", {}).get("phases", [])),
                         "status": ps.get("statusModule", {}).get("overallStatus", ""),
                         "via_synonym": code})
        hits.sort(key=lambda h: h["first_posted"])
        raw[key] = hits
        if hits:
            print(f"  {inn} via {code}: earliest {hits[0]['first_posted']} {hits[0]['nct']}")
        updated += 1
        time.sleep(0.35)
json.dump(raw, open(CACHE, "w"), indent=1)
print(f"\n{updated} synonym queries added")
