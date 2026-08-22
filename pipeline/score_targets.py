"""Score every ranked gene as a potential SLE drug target.

The leaderboard score answers "how much is the field talking about this gene?".
That is a popularity measure, and popularity is not the same as opportunity —
the genes at the top are the ones already drugged. This module scores a
different question: *should someone start a drug programme here?*

Four pillars, each built from named criteria that are shipped alongside the
score so the dashboard can show exactly why a gene ranks where it does:

  Evidence      Is the link to lupus real, causal, and current?
  Tractability  Could a molecule actually hit this protein?
  Safety        Is inhibiting it likely to be tolerated?
  Opportunity   Is the space open — and has someone already proven the
                pharmacology in a neighbouring autoimmune disease?

Opportunity deliberately runs *backwards* to the leaderboard: an approved SLE
drug scores near zero, because that target is no longer an opportunity.

The pillars are not substitutable, so they are not purely additive. Evidence
acts as a gate: a beautifully druggable protein with no credible link to lupus
is not a lupus target, and no amount of tractability should rescue it. The
weighted sum is multiplied by a factor that rises from EVIDENCE_FLOOR at zero
evidence to 1.0 at EVIDENCE_FULL.

Writes data/targets.json.
"""
import json
import math
import os
from collections import defaultdict

import config

# Evidence gate: below EVIDENCE_FULL the whole score is scaled down, never
# below EVIDENCE_FLOOR. Calibrated so roughly the top 15% of genes by evidence
# take no penalty at all.
EVIDENCE_FULL = 0.45
EVIDENCE_FLOOR = 0.35

# Below this many total PubMed papers the specificity ratio is noise — a gene
# whose literature mostly uses a Greek-letter or spelled-out name has a
# spuriously small denominator, so it scores neutral instead.
MIN_SPECIFICITY_DENOMINATOR = 150

# --- clinical stage scales -------------------------------------------------
# How open the SLE space still is. An approved drug means the question is
# answered; nothing in the clinic means the whole space is available.
SLE_WHITESPACE = {
    None: 1.0, "UNKNOWN": 0.95, "PRECLINICAL": 0.85, "PHASE_1": 0.65,
    "PHASE_1_2": 0.6, "PHASE_2": 0.4, "PHASE_2_3": 0.25, "PHASE_3": 0.2,
    "APPROVAL": 0.05,
}
# How much a drug in another immune-mediated disease de-risks this target.
CROSS_STAGE = {
    "APPROVAL": 1.0, "PHASE_3": 0.8, "PHASE_2_3": 0.7, "PHASE_2": 0.55,
    "PHASE_1_2": 0.4, "PHASE_1": 0.35, "PRECLINICAL": 0.15, "UNKNOWN": 0.1,
}
STAGE_LABEL = {
    "APPROVAL": "approved", "PHASE_3": "Phase 3", "PHASE_2_3": "Phase 2/3",
    "PHASE_2": "Phase 2", "PHASE_1_2": "Phase 1/2", "PHASE_1": "Phase 1",
    "PRECLINICAL": "preclinical", "UNKNOWN": "unknown stage",
}
# Targets with an SLE programme at Phase 2 or beyond: the biology someone has
# already bet real money on, used as the anchor for network proximity.
VALIDATED_STAGES = {"APPROVAL", "PHASE_3", "PHASE_2_3", "PHASE_2"}

# --- tractability -----------------------------------------------------------
# Open Targets assesses each modality with its own ladder of evidence. Scores
# are "how far along is the case that this modality can hit this protein".
MODALITY_LABEL = {"SM": "Small molecule", "AB": "Antibody",
                  "PR": "PROTAC / degrader", "OC": "Other modality"}
TRACT_SCORES = {
    "SM": {"Approved Drug": 1.0, "Advanced Clinical": 0.9, "Phase 1 Clinical": 0.8,
           "Structure with Ligand": 0.6, "High-Quality Ligand": 0.55,
           "High-Quality Pocket": 0.5, "Med-Quality Pocket": 0.4,
           "Druggable Family": 0.35},
    "AB": {"Approved Drug": 1.0, "Advanced Clinical": 0.9, "Phase 1 Clinical": 0.8,
           "UniProt loc high conf": 0.6, "GO CC high conf": 0.55,
           "UniProt SigP or TMHMM": 0.5, "UniProt loc med conf": 0.45,
           "GO CC med conf": 0.4, "Human Protein Atlas loc": 0.4},
    "PR": {"Approved Drug": 1.0, "Advanced Clinical": 0.9, "Phase 1 Clinical": 0.8,
           "Literature": 0.5, "Small Molecule Binder": 0.4,
           "UniProt Ubiquitination": 0.35, "Database Ubiquitination": 0.3,
           "Half-life Data": 0.25},
    "OC": {"Approved Drug": 1.0, "Advanced Clinical": 0.9, "Phase 1 Clinical": 0.8},
}
# Historical drug-discovery success by protein class: membrane receptors and
# surface antigens are the classic biologic targets, transcription factors are
# the classic hard ones.
FAMILY_SCORES = {
    "Membrane receptor": 0.9, "Surface antigen": 0.9, "Ion channel": 0.85,
    "Secreted protein": 0.85, "Enzyme": 0.8, "Transporter": 0.8,
    "Epigenetic regulator": 0.7, "Adhesion": 0.6, "Other cytosolic protein": 0.4,
    "Structural protein": 0.3, "Other nuclear protein": 0.3,
    "Transcription factor": 0.25, "Unclassified protein": 0.2,
}

# --- criteria ---------------------------------------------------------------
# (id, pillar, weight within pillar, label, what it means, source)
CRITERIA = [
    ("genetics", "evidence", 0.35, "Genetic association",
     "Variant-level human genetics tying the gene to SLE — the evidence class "
     "that best predicts clinical success.", "Open Targets"),
    ("association", "evidence", 0.25, "Overall SLE association",
     "Open Targets' combined association score across every evidence class.",
     "Open Targets"),
    ("specificity", "evidence", 0.20, "Literature specificity",
     "Share of the gene's entire PubMed footprint that is lupus literature. "
     "Separates genes the field studies in lupus from genes studied everywhere.",
     "PubMed"),
    ("momentum", "evidence", 0.20, "Research momentum",
     "Papers in the last 5 years against the 5 before — is interest "
     "accelerating right now?", "PubMed"),

    ("modality", "tractability", 0.40, "Best modality",
     "The most advanced tractability assessment across small molecule, "
     "antibody, degrader and other modalities.", "Open Targets"),
    ("chemistry", "tractability", 0.25, "Chemical matter",
     "Known ligands, a bindable pocket, small-molecule binders, high-quality "
     "chemical probes — whether you would be starting from zero.",
     "Open Targets / ChEMBL"),
    ("accessibility", "tractability", 0.20, "Biologic accessibility",
     "Secreted or membrane-embedded, so an antibody can reach it. The modality "
     "that has actually worked in lupus.", "Open Targets / UniProt"),
    ("family", "tractability", 0.15, "Family precedent",
     "How often drugs have succeeded against this protein class historically.",
     "Open Targets / ChEMBL classes"),

    ("constraint", "safety", 0.25, "LoF tolerance",
     "gnomAD constraint. Humans carrying loss-of-function variants without harm "
     "is a natural experiment in what inhibiting the target does.", "gnomAD"),
    ("mouse_ko", "safety", 0.25, "Mouse knockout burden",
     "How many significant phenotypes the mouse knockout shows. Fewer means "
     "fewer surprises on-target.", "IMPC / MGI"),
    ("essentiality", "safety", 0.20, "Non-essentiality",
     "Cell-line essentiality. A common-essential gene is a bad target for "
     "systemic inhibition.", "DepMap"),
    ("expression_focus", "safety", 0.15, "Expression focus",
     "Restricted to a few tissues and cell types rather than ubiquitous — "
     "fewer places to cause off-tissue effects.", "HPA / GTEx"),
    ("liabilities", "safety", 0.15, "Clean safety record",
     "Absence of curated adverse-event liabilities and cancer-driver status "
     "for this target.", "Open Targets safety"),

    ("whitespace", "opportunity", 0.40, "Unclaimed space",
     "Runs backwards to the leaderboard: no SLE programme scores high, an "
     "approved SLE drug scores near zero. That target is answered, not open.",
     "Open Targets / ChEMBL"),
    ("repurposing", "opportunity", 0.35, "Cross-indication precedent",
     "A drug already hitting this target in another immune-mediated disease — "
     "proven human pharmacology one indication away.", "Open Targets / ChEMBL"),
    ("network", "opportunity", 0.25, "Network proximity",
     "Physical interaction with proteins that already carry an SLE programme "
     "at Phase 2 or beyond — guilt by association with validated biology.",
     "IntAct"),
]

# Human-readable names for the raw Open Targets identifiers, so the detail
# lines read as prose rather than database keys.
DATASOURCE_LABELS = {
    "gwas_credible_sets": "GWAS credible sets", "gene_burden": "rare-variant burden",
    "eva": "ClinVar", "uniprot_variants": "UniProt variants",
    "uniprot_literature": "UniProt literature", "clingen": "ClinGen",
    "genomics_england": "Genomics England PanelApp", "orphanet": "Orphanet",
}
DATATYPE_LABELS = {
    "genetic_association": "genetic association", "genetic_literature": "curated genetics",
    "rna_expression": "RNA expression", "clinical": "clinical precedence",
    "animal_model": "animal model", "literature": "text mining",
    "somatic_mutation": "somatic mutation",
}
CHEM_LABELS = {
    "hasLigand": "known ligand", "hasPocket": "bindable pocket",
    "hasSmallMoleculeBinder": "small-molecule binder",
    "hasHighQualityChemicalProbes": "high-quality chemical probe",
}

PILLARS = [
    ("evidence", "Evidence",
     "Is the link between this gene and lupus real, causal, and current?"),
    ("tractability", "Tractability",
     "Could a drug molecule actually engage this protein?"),
    ("safety", "Safety",
     "Is inhibiting it likely to be tolerated? Higher is safer."),
    ("opportunity", "Opportunity",
     "Is the space still open, and has the pharmacology been proven nearby?"),
]


def clamp(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))


def signed_to_unit(v, default=0.5):
    """Open Targets prioritisation values run -1..1; map to 0..1."""
    if v is None:
        return default
    return clamp((v + 1) / 2)


def percentile_ranks(values):
    """Map a skewed raw quantity onto an even 0..1 spread by rank."""
    order = sorted(range(len(values)), key=lambda i: values[i])
    out = [0.0] * len(values)
    n = max(len(values) - 1, 1)
    for position, i in enumerate(order):
        out[i] = position / n
    return out


def best_tractability(tract):
    """Highest-scoring assessment across every modality."""
    best = (0.0, None, None)
    for modality, labels in (tract or {}).items():
        table = TRACT_SCORES.get(modality, {})
        for label in labels:
            score = table.get(label, 0.0)
            if score > best[0]:
                best = (score, modality, label)
    return best


def load(path, default):
    if not os.path.exists(path):
        print(f"NOTE: {os.path.basename(path)} missing — that signal scores neutral")
        return default
    with open(path) as f:
        return json.load(f)


def main():
    with open(os.path.join(config.DATA_DIR, "genes.json")) as f:
        genes = json.load(f)["genes"]
    profiles = load(config.TARGET_PROFILE_FILE, {})
    cross = load(config.CROSS_DRUGS_FILE, {})
    totals = load(config.SPECIFICITY_FILE, {})

    # Anchor set for network proximity: SLE programmes at Phase 2 or beyond.
    validated = {g["symbol"] for g in genes
                 if g.get("drug_stage") in VALIDATED_STAGES}
    print(f"{len(validated)} targets with an SLE programme at Phase 2+: "
          f"{', '.join(sorted(validated)[:12])}…")

    # Literature specificity is wildly skewed (ratios span four orders of
    # magnitude), so rank rather than scale it.
    raw_specificity, specificity_usable = [], []
    for g in genes:
        rec = totals.get(g["symbol"]) or {}
        total = rec.get("total") or 0
        usable = total >= MIN_SPECIFICITY_DENOMINATOR
        specificity_usable.append(usable)
        # Alias expansion makes the denominator comparable to PubTator's
        # synonym-resolved numerator, but it is not guaranteed to cover every
        # naming variant, so clamp rather than let a ratio exceed 1.
        raw_specificity.append(min(g["papers"] / total, 1.0) if usable else 0.0)
    ranked = percentile_ranks(raw_specificity)
    # Genes with too small a denominator sit at the middle rather than the
    # bottom: unknown is not the same as unspecific.
    specificity_rank = [r if ok else 0.5 for r, ok in zip(ranked, specificity_usable)]

    targets = []
    for i, g in enumerate(genes):
        symbol = g["symbol"]
        p = profiles.get(symbol, {})
        prio = p.get("prio", {})
        scores, detail = {}, {}

        # --- evidence ------------------------------------------------------
        scores["genetics"] = clamp(g.get("ot_genetic") or 0.0)
        gen_sources = [k for k in g.get("ot_datasources", {})
                       if k in ("gwas_credible_sets", "gene_burden", "eva",
                                "uniprot_variants", "clingen", "genomics_england",
                                "orphanet", "uniprot_literature")]
        detail["genetics"] = (
            ", ".join(sorted(DATASOURCE_LABELS.get(k, k) for k in gen_sources))
            if gen_sources else "no genetic evidence in Open Targets")

        scores["association"] = clamp(g.get("ot_score") or 0.0)
        datatypes = g.get("ot_datatypes", {})
        detail["association"] = (
            f"{len(datatypes)} evidence class{'es' if len(datatypes) != 1 else ''}: "
            + ", ".join(sorted(DATATYPE_LABELS.get(k, k) for k in datatypes))
            if datatypes else "not in the SLE association set")

        scores["specificity"] = round(specificity_rank[i], 3)
        spec_rec = totals.get(symbol) or {}
        spec_total = spec_rec.get("total") or 0
        if specificity_usable[i]:
            share = 100 * min(g["papers"] / spec_total, 1.0)
            alias_note = (" (incl. " + ", ".join(spec_rec.get("aliases", [])[:3]) + ")"
                          if spec_rec.get("aliases") else "")
            detail["specificity"] = (
                f"{g['papers']:,} of {spec_total:,} PubMed papers mentioning "
                f"{symbol}{alias_note} are lupus papers ({share:.1f}%)")
        else:
            detail["specificity"] = (
                f"only {spec_total:,} PubMed papers name {symbol} directly — too few "
                "to judge specificity, scored neutral")

        velocity = g.get("velocity") or 1.0
        scores["momentum"] = round(clamp(math.log(max(velocity, 0.05)) / math.log(3.0)), 3)
        detail["momentum"] = (f"{g['recent_papers']} papers in the last 5 years vs "
                              f"{g.get('prior_papers', 0)} in the 5 before ({velocity}×)")

        # --- tractability --------------------------------------------------
        t_score, t_mod, t_label = best_tractability(p.get("tract"))
        scores["modality"] = round(t_score, 3)
        detail["modality"] = (f"{MODALITY_LABEL.get(t_mod, t_mod)}: {t_label}"
                              if t_mod else "no tractability evidence")

        chem_keys = ["hasLigand", "hasPocket", "hasSmallMoleculeBinder",
                     "hasHighQualityChemicalProbes"]
        chem_hits = [k for k in chem_keys if prio.get(k, 0) > 0]
        scores["chemistry"] = round(len(chem_hits) / len(chem_keys), 3)
        detail["chemistry"] = (", ".join(CHEM_LABELS.get(k, k) for k in chem_hits)
                               if chem_hits else "no ligand, pocket or probe on record")

        secreted, membrane = prio.get("isSecreted", 0), prio.get("isInMembrane", 0)
        scores["accessibility"] = round(clamp(max(secreted, membrane)), 3)
        detail["accessibility"] = (
            "secreted" if secreted > 0 else
            "membrane-embedded" if membrane > 0 else
            "intracellular — small molecule or degrader only")

        classes = p.get("classes") or []
        fam = max((FAMILY_SCORES.get(c, 0.2) for c in classes), default=0.2)
        scores["family"] = round(fam, 3)
        detail["family"] = (" / ".join(classes + p.get("classes_l2", [])[:1])
                            if classes else "protein class not assigned")

        # --- safety --------------------------------------------------------
        scores["constraint"] = round(signed_to_unit(prio.get("geneticConstraint")), 3)
        lof = p.get("lof") or {}
        detail["constraint"] = (
            f"gnomAD LoF observed/expected {lof['oe']:.2f}"
            + (f", constraint decile {lof['bin']}/5" if lof.get("bin") is not None else "")
            if lof.get("oe") is not None else "gnomAD constraint not available")

        scores["mouse_ko"] = round(signed_to_unit(prio.get("mouseKOScore")), 3)
        detail["mouse_ko"] = ("no mouse knockout data" if "mouseKOScore" not in prio
                              else "few knockout phenotypes"
                              if prio["mouseKOScore"] > -0.4 else
                              "many significant knockout phenotypes")

        if p.get("essential"):
            scores["essentiality"] = 0.0
            detail["essentiality"] = "common-essential in DepMap — poor target for systemic inhibition"
        else:
            scores["essentiality"] = round(signed_to_unit(prio.get("geneEssentiality")), 3)
            detail["essentiality"] = ("not essential in cell-line screens"
                                      if prio.get("geneEssentiality", 0) == 0
                                      else "some essentiality signal in DepMap")

        focus = [prio[k] for k in ("tissueSpecificity", "celltypeSpecificity")
                 if k in prio]
        scores["expression_focus"] = round(
            signed_to_unit(sum(focus) / len(focus) if focus else None), 3)
        detail["expression_focus"] = ("expression breadth not available" if not focus
                                      else "restricted expression"
                                      if sum(focus) / len(focus) > 0.2 else
                                      "broadly expressed across tissues and cell types")

        events = p.get("safety") or []
        liability = 1.0 / (1 + 0.3 * len(events))
        if prio.get("isCancerDriverGene", 0) < 0:
            liability *= 0.7
        scores["liabilities"] = round(clamp(liability), 3)
        bits = []
        if events:
            bits.append(f"{len(events)} curated liabilities: " + ", ".join(events[:4]))
        if prio.get("isCancerDriverGene", 0) < 0:
            bits.append("known cancer driver gene")
        detail["liabilities"] = "; ".join(bits) if bits else "no curated safety liabilities"

        # --- opportunity ---------------------------------------------------
        stage = g.get("drug_stage")
        scores["whitespace"] = SLE_WHITESPACE.get(stage, 1.0)
        detail["whitespace"] = (
            f"SLE programme at {STAGE_LABEL.get(stage, stage)}: "
            + ", ".join(d["drug"] for d in (g.get("drugs") or [])[:3])
            if stage else "no drug or trial candidate against this target in SLE")

        entries = cross.get(symbol) or []
        best_cross, best_entry = 0.0, None
        for e in entries:
            v = CROSS_STAGE.get(e["stage"], 0.1) * e.get("weight", 1.0)
            if v > best_cross:
                best_cross, best_entry = v, e
        scores["repurposing"] = round(clamp(best_cross), 3)
        if best_entry:
            others = {e["disease"] for e in entries}
            detail["repurposing"] = (
                f"{best_entry['drug']} — {STAGE_LABEL.get(best_entry['stage'], best_entry['stage'])} "
                f"in {best_entry['disease']}"
                + (f" (+{len(others) - 1} more indications)" if len(others) > 1 else ""))
        else:
            detail["repurposing"] = "no drug against this target in another immune-mediated disease"

        partners = p.get("partners") or []
        hits = [q for q in partners if q["symbol"] in validated and q["symbol"] != symbol]
        scores["network"] = round(1 - math.exp(-len(hits) / 2.0), 3)
        detail["network"] = (
            "interacts with " + ", ".join(q["symbol"] for q in hits[:6])
            + (f" and {len(hits) - 6} more" if len(hits) > 6 else "")
            if hits else
            f"{len(partners)} IntAct partners, none with an SLE programme")

        targets.append({
            "symbol": symbol,
            "name": g["name"],
            "entrez": g["entrez"],
            "lit_rank": g["rank"],
            "papers": g["papers"],
            "recent_papers": g["recent_papers"],
            "trend": g.get("trend"),
            "sle_stage": stage,
            "sle_drugs": (g.get("drugs") or [])[:6],
            "cross_drugs": entries[:8],
            "partners": [q["symbol"] for q in hits[:12]],
            "classes": classes,
            "locations": p.get("locations", [])[:4],
            "profiled": bool(p),
            "s": scores,
            "d": detail,
        })

    # --- combine ------------------------------------------------------------
    by_pillar = defaultdict(list)
    for cid, pillar, weight, *_ in CRITERIA:
        by_pillar[pillar].append((cid, weight))

    for t in targets:
        pillars = {}
        for pillar, members in by_pillar.items():
            total_w = sum(w for _, w in members)
            pillars[pillar] = round(
                sum(t["s"].get(cid, 0.0) * w for cid, w in members) / total_w, 4)
        t["p"] = pillars
        gate = clamp(EVIDENCE_FLOOR + (1 - EVIDENCE_FLOOR)
                     * pillars["evidence"] / EVIDENCE_FULL, EVIDENCE_FLOOR, 1.0)
        t["gate"] = round(gate, 3)
        t["tos"] = round(100 * gate * sum(config.PILLAR_WEIGHTS[k] * v
                                          for k, v in pillars.items()), 1)

        flags = []
        if t["s"]["repurposing"] >= 0.7 and t["s"]["whitespace"] >= 0.6:
            flags.append("repurposing")
        if not t["sle_stage"] and pillars["evidence"] >= 0.45 and pillars["tractability"] >= 0.5:
            flags.append("whitespace")
        if pillars["safety"] < 0.35:
            flags.append("safety")
        if t["sle_stage"] == "APPROVAL":
            flags.append("approved")
        t["flags"] = flags

    targets.sort(key=lambda t: -t["tos"])
    for rank, t in enumerate(targets, 1):
        t["rank"] = rank

    payload = {
        "pillars": [{"id": i, "label": l, "help": h} for i, l, h in PILLARS],
        "pillar_weights": config.PILLAR_WEIGHTS,
        "evidence_gate": {"full": EVIDENCE_FULL, "floor": EVIDENCE_FLOOR},
        "criteria": [{"id": i, "pillar": p, "weight": w, "label": l,
                      "help": h, "source": s} for i, p, w, l, h, s in CRITERIA],
        "cross_indications": sorted({label for label, _ in config.CROSS_INDICATIONS.values()}),
        "validated_anchors": sorted(validated),
        "targets": targets,
    }
    out = os.path.join(config.DATA_DIR, "targets.json")
    with open(out, "w") as f:
        json.dump(payload, f)

    print(f"Wrote {len(targets)} scored targets to {out}")
    print("\nTop 20 by Target Opportunity Score:")
    for t in targets[:20]:
        print(f"  {t['rank']:3d}. {t['symbol']:10s} {t['tos']:5.1f}  "
              f"E{t['p']['evidence']:.2f} T{t['p']['tractability']:.2f} "
              f"S{t['p']['safety']:.2f} O{t['p']['opportunity']:.2f}  "
              f"[{','.join(t['flags']) or '-'}]  lit#{t['lit_rank']}")


if __name__ == "__main__":
    main()
