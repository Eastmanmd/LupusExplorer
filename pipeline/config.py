"""Shared configuration for the lupus literature pipeline."""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_DIR = os.path.join(ROOT, "cache")
DATA_DIR = os.path.join(ROOT, "data")

# PubMed query defining the lupus corpus
PUBMED_QUERY = '"lupus erythematosus, systemic"[MeSH] OR lupus[tiab]'

# NCBI E-utilities
EUTILS_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
EUTILS_DELAY = 0.4  # seconds between requests (3/sec limit without API key)

# PubTator 3
PUBTATOR_EXPORT = (
    "https://www.ncbi.nlm.nih.gov/research/pubtator3-api/publications/export/biocjson"
)
PUBTATOR_BATCH = 100      # PMIDs per request (API max)
PUBTATOR_DELAY = 0.35

# Open Targets
OPENTARGETS_GRAPHQL = "https://api.platform.opentargets.org/api/v4/graphql"
SLE_EFO_ID = "MONDO_0007915"  # systemic lupus erythematosus

# g:Profiler enrichment
GPROFILER_URL = "https://biit.cs.ut.ee/gprofiler/api/gost/profile/"

# Scoring / output knobs
MIN_PAPERS_FOR_CANDIDATE = 5   # gene must appear in >= N papers to be considered
TOP_N_GENES = 300              # genes shipped to the dashboard
ARTICLES_PER_GENE = 40         # most-recent articles kept per gene
RECENT_YEARS = 5               # window for the recency component
SCORE_WEIGHTS = {"mentions": 0.4, "recency": 0.3, "opentargets": 0.3}

# Files
PMIDS_FILE = os.path.join(CACHE_DIR, "pmids.txt")
MENTIONS_FILE = os.path.join(CACHE_DIR, "mentions.jsonl")
OPENTARGETS_FILE = os.path.join(CACHE_DIR, "opentargets.json")
GENE_INFO_FILE = os.path.join(CACHE_DIR, "gene_info.json")
ENRICHMENT_FILE = os.path.join(CACHE_DIR, "enrichment.json")
