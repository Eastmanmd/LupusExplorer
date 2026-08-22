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
DRUGS_FILE = os.path.join(CACHE_DIR, "drugs.json")
GENE_INFO_FILE = os.path.join(CACHE_DIR, "gene_info.json")
ENRICHMENT_FILE = os.path.join(CACHE_DIR, "enrichment.json")

# --- Target opportunity scoring -------------------------------------------
# Immune-mediated indications used for the cross-indication ("repurposing")
# signal: a drug that already works against this target in one of these is
# human-validated pharmacology one indication away from SLE. IDs verified
# against the Open Targets disease index; SLE itself is deliberately absent.
CROSS_INDICATIONS = {
    # Strong read-across: systemic autoimmunity / connective tissue disease
    "MONDO_0008383": ("rheumatoid arthritis", 1.0),
    "MONDO_0010030": ("Sjogren syndrome", 1.0),
    "MONDO_0005100": ("systemic sclerosis", 1.0),
    "MONDO_0016367": ("dermatomyositis", 1.0),
    "MONDO_0600023": ("idiopathic inflammatory myopathy", 1.0),
    "MONDO_0012105": ("granulomatosis with polyangiitis", 1.0),
    "MONDO_8000010": ("antiphospholipid syndrome", 1.0),
    "MONDO_0008558": ("immune thrombocytopenic purpura", 1.0),
    "MONDO_0020108": ("autoimmune hemolytic anemia", 1.0),
    "MONDO_0005342": ("IgA nephropathy", 1.0),
    "MONDO_0005376": ("membranous nephropathy", 1.0),
    "MONDO_0011429": ("juvenile idiopathic arthritis", 1.0),
    "MONDO_0009688": ("myasthenia gravis", 1.0),
    # Adjacent immune-mediated disease: same drug classes, different tissue
    "MONDO_0005083": ("psoriasis", 0.7),
    "MONDO_0011849": ("psoriatic arthritis", 0.7),
    "MONDO_0005011": ("Crohn disease", 0.7),
    "MONDO_0005101": ("ulcerative colitis", 0.7),
    "MONDO_0005301": ("multiple sclerosis", 0.7),
    "MONDO_0005306": ("ankylosing spondylitis", 0.7),
    "MONDO_0005147": ("type 1 diabetes", 0.7),
    "MONDO_0004980": ("atopic dermatitis", 0.7),
    "MONDO_0008661": ("vitiligo", 0.7),
    "MONDO_0006559": ("hidradenitis suppurativa", 0.7),
    "MONDO_0013730": ("graft versus host disease", 0.7),
    "MONDO_0008538": ("giant cell arteritis", 0.7),
    "MONDO_0007191": ("Behcet disease", 0.7),
    "MONDO_0019338": ("sarcoidosis", 0.7),
    "MONDO_0016264": ("autoimmune hepatitis", 0.7),
    "MONDO_0005130": ("celiac disease", 0.7),
    "MONDO_0005623": ("autoimmune thyroid disease", 0.7),
}

# Pillar weights for the Target Opportunity Score (must sum to 1.0)
PILLAR_WEIGHTS = {
    "evidence": 0.30,
    "tractability": 0.30,
    "safety": 0.20,
    "opportunity": 0.20,
}

TARGET_PROFILE_FILE = os.path.join(CACHE_DIR, "target_profile.json")
CROSS_DRUGS_FILE = os.path.join(CACHE_DIR, "cross_drugs.json")
SPECIFICITY_FILE = os.path.join(CACHE_DIR, "specificity.json")
