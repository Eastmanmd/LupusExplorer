"""Run the full pipeline end to end (used by the weekly GitHub Action)."""
import subprocess
import sys
import os

HERE = os.path.dirname(os.path.abspath(__file__))

STEPS = [
    "fetch_pmids.py",
    "fetch_pubtator.py",
    "fetch_opentargets.py",
    "fetch_drugs.py",
    "build_data.py",       # first pass: ranks genes
    "enrich_pathways.py",  # needs genes.json from the pass above
    "build_data.py",       # second pass: folds enrichment in
    # Drug-target scoring. Everything below needs the ranked gene list from
    # build_data.py, so it runs after the leaderboard is settled.
    "fetch_target_profile.py",  # tractability, constraint, essentiality, PPI
    "fetch_cross_drugs.py",     # drugs against these targets in other
                                # immune-mediated indications
    "fetch_specificity.py",     # each gene's total PubMed footprint
    "score_targets.py",         # combines the above into data/targets.json
]

for step in STEPS:
    print(f"\n=== {step} ===", flush=True)
    result = subprocess.run([sys.executable, os.path.join(HERE, step)])
    if result.returncode != 0:
        sys.exit(f"{step} failed with exit code {result.returncode}")
print("\nPipeline complete.")
