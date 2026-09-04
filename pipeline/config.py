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

# --- Emerging genes -------------------------------------------------------
# The leaderboard score is monotone in accumulated attention, so a gene whose
# entire lupus literature is four years old cannot rank however hot it is.
# build_emerging.py selects on the opposite question: how improbable is it that
# a gene's lupus papers are this concentrated in the recent window?
EMERGING_MAX_PAPERS = 150      # "not yet popular" — hard cap on total lupus papers
EMERGING_MIN_RECENT = 4        # ignore 2-of-2 flukes
EMERGING_P_THRESHOLD = 0.01    # binomial tail probability against the corpus baseline
EMERGING_ARTICLES_PER_GENE = 8 # recent papers shipped per emerging gene
# Quadrant splits. Fixed rather than data-derived medians so a gene does not
# silently change quadrant on a weekly refresh.
EMERGING_MATURITY_SPLIT = 1000  # total PubMed papers: studied elsewhere or not
EMERGING_NOVELTY_SPLIT = 0.75   # share of lupus papers inside the recent window
# Corroboration ratio (independent PubMed keyword hits / PubTator mentions)
# outside this range means the two counts disagree — see build_emerging.py.
EMERGING_CORROBORATION_RANGE = (0.25, 8.0)

# --- Co-mention network ------------------------------------------------------
# Built from cache/mentions.jsonl and nothing else: every edge, weight and
# module comes from which genes PubTator found in the same abstract. The node
# set is deliberately the top N by *lupus paper count* rather than by the
# leaderboard's combined score, because that score is 30% Open Targets — a
# network billed as pure co-mention should not have its membership decided by
# a curated database. (The two sets differ by 52 of 300 genes.)
NETWORK_NODES = 300            # genes on the map, by lupus paper count
NETWORK_MAX_PAPER_GENES = 15   # skip broad surveys: one 45-gene paper is 990 pairs
NETWORK_MIN_CO = 4             # a pair needs this many co-mentions to be considered
NETWORK_P_THRESHOLD = 1e-6     # hypergeometric tail, ~Bonferroni over ~45k pairs
NETWORK_EDGES_PER_NODE = 6     # backbone: strongest k edges per gene, unioned
NETWORK_EGO_MIN_CO = 3         # off-map genes need this per partner for an ego view
NETWORK_EGO_MIN_PARTNERS = 1   # one strong partner is worth more than three weak
                               # ones: NELL1 shares 17 papers with PLA2R1 and
                               # almost nothing else, which is the whole story
NETWORK_MIN_COLOURED_SIZE = 10 # smaller modules render grey rather than
                               # spending a legend row on two genes
NETWORK_PALETTE_SIZE = 11      # colours available; modules beyond this go grey
NETWORK_LAYOUT_SEED = 7
NETWORK_LAYOUT_ITERATIONS = 250

# PubTator resolves synonyms, so a gene whose alias is also a trending acronym
# inherits that acronym's papers. In the long tail a single collision is enough
# to manufacture a top-ranked "emerging gene". These were confirmed by reading
# the matched titles; the corroboration ratio catches unlisted cases.
ALIAS_COLLISIONS = {
    "NR1I3": "CAR (constitutive androstane receptor) vs CAR-T cell therapy",
    "CXADRP1": "CAR (coxsackie-adenovirus receptor) vs CAR-T cell therapy",
    "CARTPT": "CART vs CAR-T cell therapy",
    "ABCB6": "ABC vs atypical B cells",
    "RALGAPA1": "TULIP1 vs the TULIP-1/TULIP-2 anifrolumab trials",
}

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
EMERGING_FILE = os.path.join(DATA_DIR, "emerging.json")
NETWORK_FILE = os.path.join(DATA_DIR, "network.json")
NETWORK_MODULES_FILE = os.path.join(CACHE_DIR, "network_modules.json")

# --- APOL1 tracker ----------------------------------------------------------
# APOL1 is invisible to every other tab by construction: 40 lupus papers puts it
# far outside the top-300 leaderboard and network node sets, its Open Targets
# SLE association is 0.06, and its papers are spread evenly over 2012-2026 so it
# fails the emerging-gene concentration test. The biology is real anyway — the
# G1/G2 risk genotypes drive progression to ESKD in lupus nephritis — so it gets
# a tab of its own rather than a scoring exemption somewhere else.
APOL1_ENTREZ = "8542"
# Deliberately wider than the lupus corpus. Only ~49 papers sit in the
# intersection, and 28 of those 40 that PubTator tags mention APOL1 and no other
# gene, so a graph built on the intersection alone is a picture of two abstracts
# (see the two-ring note below). The full APOL1 literature supplies the second
# ring; membership in the lupus corpus is what the rings distinguish.
APOL1_QUERY = 'APOL1[tiab] OR "apolipoprotein L1"[tiab] OR APOL1[All Fields]'

# Table: a partner gene needs this many co-mentions with APOL1 anywhere in the
# APOL1 corpus to be listed at all. 1 would admit every gene named once in
# passing in any of 1,300 papers.
APOL1_TABLE_MIN_CO = 1          # lupus ring: every intersection partner counts
APOL1_OUTER_MIN_CO = 3          # outer ring is big, so it has to earn its place
APOL1_OUTER_MAX = 70            # cap on outer-ring nodes, by weighted strength

# Lupus co-mentions count for this many ordinary APOL1 co-mentions when edges
# are weighted and when the outer ring is truncated. The tab's question is
# "what does APOL1 biology look like from lupus", so a pair seen once in a
# lupus paper should outrank a pair seen twice in unrelated nephrology.
APOL1_LUPUS_EDGE_WEIGHT = 4.0
APOL1_PARTNER_MIN_CO = 2        # partner-partner edge needs this many papers
APOL1_PARTNER_P = 1e-4          # hypergeometric gate on partner-partner edges

APOL1_PMIDS_FILE = os.path.join(CACHE_DIR, "apol1_pmids.txt")
APOL1_MENTIONS_FILE = os.path.join(CACHE_DIR, "apol1_mentions.jsonl")
APOL1_FILE = os.path.join(DATA_DIR, "apol1.json")
APOL1_MODULES_FILE = os.path.join(CACHE_DIR, "apol1_modules.json")
