---
name: medical-literature
description: >-
  Search, cite, and read medical literature with the medical_literature_* tools (PubMed, Europe PMC,
  arXiv, bioRxiv, medRxiv). Use when finding papers, building a systematic/scoping review query,
  formatting references during manuscript polishing (Vancouver, APA, GB/T 7714, Nature, BibTeX, RIS,
  CSL-JSON), or reading open-access full text to check whether a citation supports a sentence.
whenToUse: >-
  Use before medical_literature_search when field-level precision matters, when translating one
  research question into source-specific queries, when inserting or reformatting references in a
  manuscript, when a citation needs verification against the source text, or when a previous search
  returned zero or noisy results.
---

# Medical literature: search, cite, full text

Five tools cover the polishing loop:

| Tool | Use it for |
|---|---|
| `medical_literature_search` | find papers across PubMed, Europe PMC, arXiv, bioRxiv, medRxiv |
| `medical_literature_get` | resolve one DOI/PMID/PMCID/arXiv id to full metadata + abstract |
| `medical_literature_cite` | turn identifiers into a formatted reference or a `.bib`/`.ris`/CSL file |
| `medical_literature_fulltext` | read open-access full text and save it as Markdown |
| `medical_literature_check` | locate passages supporting a claim; audit duplicates and retractions |

## 1. Search contract

```jsonc
// Shared free text: adapted per source (arXiv drops English stopwords)
{ "query": "CRISPR base editing", "sources": ["pubmed", "arxiv"] }

// Per-source precision: values are sent verbatim to that engine
{
  "queries": {
    "pubmed":    "(CRISPR[tiab] OR \"Gene Editing\"[MeSH Terms]) AND 2023:2026[dp]",
    "europepmc": "TITLE_ABS:CRISPR AND MESH:\"Gene Editing\" AND PUB_YEAR:[2023 TO 2026]",
    "arxiv":     "(abs:CRISPR OR abs:\"base editing\") AND cat:q-bio.QM"
  }
}
```

Rules:

- `queries` wins per source; `query` is the fallback for sources without an override.
- If `sources` is omitted and `queries` is present, the keys of `queries` become the source list.
- If `sources` is explicit, **every** source needs `queries.<source>` or a shared `query`.
- `year_from` / `year_to` add a native date filter; do not repeat dates inside `queries`.
- Cross-engine syntax is rejected **before** any request: a `[tiab]` tag sent to Europe PMC, or a
  `TITLE_ABS:` field sent to PubMed, raises an actionable error. Fix the query, don't blame the source.
- `queries` values are not rewritten: no stopword removal, no syntax translation.
- `max_results` is the final count after fusion; `candidates` is the per-source recall window
  (default `max(20, 3x max_results)`). Raise `candidates` when a paper sits below the source's top few.
- `fusion` defaults to `rrf`, which uses only each engine's own ranks. `source` keeps source blocks;
  `bm25` is a local term-frequency re-rank that ignores MeSH/citation/recency — opt-in only.
  Do not assume `bm25` is better: PubMed Best Match already encodes domain signals.
- `sort: "cited"` orders by Europe PMC citation count and requires `sources: ["europepmc"]` alone;
  use the two-track recipe below rather than mixing it with PubMed in one call.

### Known-item search (system names)

Concept blocks miss eponymous systems. `PathAgent`, `NOVA`, and `SPARK` do not contain the literal
token `agent` once tokenized, and two of them are common words. For a known system:

```jsonc
{ "queries": {
    "arxiv":  "ti:PathAgent OR ti:NOVA OR ti:SPARK",
    "pubmed": "(\"PathAgent\"[tiab] OR \"NOVA\"[tiab] OR \"SPARK\"[tiab]) AND (pathology[tiab] OR histopathology[tiab])"
} }
```

- `agent` ≠ `agentic` ≠ `PathAgent`: list `agent`, `agentic`, `"AI agent"`, `"LLM agent"` explicitly.
- `SPARK`/`NOVA` are ambiguous (`calcium sparks`, NOVA brain-MRI benchmark): add a topic term or use
  `ti:` / the arXiv id / DOI.
- Preprints (PathAgent, NOVA) are not in PubMed/Europe PMC; the published version (SPARK, Nature
  Medicine) is. Search both sides.
- A broad `OR` with a small `max_results` can push the named paper below the cutoff; query the name
  alone when you already know it.
- Watch the `source shown/total` line: `arxiv 5/444` means the method may sit at rank 42 or 150;
  raise `max_results` for a sweep, but name-search for a known method.

### Classic + frontier (two calls)

Citation counts and recency pull in opposite directions: PROSEVA (2013) has 2,638 citations while
satri-cel (2025) has far fewer. Do not average them into one score; run two cheap searches.

```jsonc
// 1. Landmark track: Europe PMC citation order (single source is required)
{ "queries": { "europepmc": "TITLE_ABS:\"prone positioning\" AND TITLE_ABS:\"acute respiratory distress syndrome\"" },
  "sources": ["europepmc"], "sort": "cited", "max_results": 5 }

// 2. Frontier track: PubMed recency or relevance
{ "queries": { "pubmed": "…the same concepts… AND randomized controlled trial[pt]" },
  "sort": "date", "max_results": 10 }
```

- `sort: "cited"` is Europe PMC only and the tool rejects a mixed source list; records carry
  `cited_by_count`, rendered as `cited N`.
- **Scope the cited query.** An unscoped `prone position AND ARDS` puts a 2021 COVID-19 cohort
  above PROSEVA because the phrase match differs; citation order still rewards broad, old papers.
  Add the design filter or a topic constraint before trusting the order.
- Present the tracks separately ("landmark evidence" vs "latest evidence") and let the reader see
  both; the tool does not merge them.

### Choosing a sort by intent

Citation order is a task choice, not a domain rule. It answers "what shaped this field?", not
"what is true now?" or "what is new?".

| Intent | `sort` | Why |
|---|---|---|
| Latest trial, new target, this year's data | `date` (or `relevance`) | a 2025 paper has had no time to accumulate citations |
| Seminal trial, classic review, guideline anchor | `cited` (Europe PMC only) | cumulative citations approximate influence |
| Systematic review / meta-analysis | `relevance` + design filters; `cited` only to seed known items | an SR needs exhaustive recall; top-k citation ranking biases inclusion |
| Rare disease / small field | `relevance` | absolute counts are low and unstable across the field |
| Recent landmark (last 3–5 years) | `cited` + `year_from` | limits age bias, not field bias |

- Citation counts are **cumulative and field-dependent**: reviews out-cite trials, oncology
  out-cites rare disease, and COVID-era papers inflate. Never compare counts across topics.
- "Highly cited" is not "valid": check `retracted` and the study design before citing.
- Do not infer the sort from the question text. "这个病怎么治" can mean "give me the current
  standard" (guideline/date) or "give me the classic evidence" (cited); ask or run both.

## 2. Clinical question → PICO blocks

A clinical question is not a query. Decompose it, map each block to MeSH + free text, then add a
study-design filter.

| Letter | Ask | Example (ARDS question) |
|---|---|---|
| P | population + setting | adults with ARDS, mechanically ventilated, ICU |
| I | intervention / exposure | early prone positioning |
| C | comparator (optional) | supine positioning |
| O | outcome (optional) | 28-day mortality |
| S | study design | RCT |

Rules:

- **MeSH first, free text always.** `[MeSH Terms]` finds indexed synonyms you did not list;
  `[tiab]` catches unindexed and brand-new terms that are not in MeSH yet. Use both.
- **Do not guess a MeSH label.** Run the skill's mapper:
  `node ~/.dsh/skills/medical-literature/scripts/mesh-map.mjs "chronic kidney disease"`.
  It prints PubMed's own translation (`"renal insufficiency, chronic"[MeSH Terms]`), the descriptor
  id, and the entry terms. No key, no install.
- **Abbreviations collide.** The mapper exposes the damage: `MACE` → *Myristica* (nutmeg),
  `ATTR` → TTR protein, `PD-1` → PDCD1. Pair the abbreviation with its expansion and a context
  term. `FOP`, `MASLD`, and trial names such as `EMPEROR-Reduced` have **no** MeSH mapping — free
  text only.
- **C is often not a query block.** A head-to-head RCT may not exist; requiring both arms returns
  post-hoc subgroup analyses and network meta-analyses. Run the I-vs-placebo search too and read
  the comparator from the abstract.
- **O belongs in screening more often than in the query.** Requiring `fibrosis[tiab]` dropped
  systematic reviews that report fibrosis as a secondary outcome (Q6: PubMed went from 2 hits
  to 8 after relaxing to `fibrosis OR steatosis OR "liver fat"`). Use two stages:
  - **P + I is already sparse** (rare disease, new drug in pregnancy): omit O entirely. Search
    `dupilumab AND (pregnancy OR "maternal exposure")`, then read malformation/miscarriage rates
    from the abstracts. Requiring `malformation OR miscarriage` kills registry studies titled
    "Pregnancy outcomes after dupilumab exposure".
  - **P + I is large** (aspirin, intermittent fasting): keep O, but bind it to organ-level or
    composite terms joined by `OR` (`fibrosis OR steatosis OR "liver fat"`, `MACE OR
    "major adverse cardiovascular events"`), never a single narrow assay.
  Keep O in the query when the outcome defines the question (mortality trials).
- **Dates** go in `year_from` / `year_to`; never also write `[dp]` inside the query.

### Study-design filters

| Design | PubMed | Europe PMC |
|---|---|---|
| RCT | `randomized controlled trial[pt]` | `PUB_TYPE:"Randomized Controlled Trial"` |
| SR / MA | `("systematic review"[pt] OR "meta-analysis"[pt])` | `PUB_TYPE:"Systematic Review"` / `"Meta-Analysis"` |
| Guideline | `("guideline"[pt] OR "practice guideline"[pt])` | `PUB_TYPE:"Guideline"` |
| Case report | `"case reports"[pt]` | `PUB_TYPE:"Case Reports"` |
| Review | `review[pt]` | `PUB_TYPE:"review"` |

`guideline[tiab]` is **not** a design filter: it matches every paper that cites a guideline
(Q5: 103 noisy hits vs 1 exact hit with `[pt]`). Start with `[pt]`; add `guideline*[ti]` or
`consensus[ti]` only for just-published documents that are not indexed yet, and expect to screen
(in Q5 the `[ti]` expansion added 8 records but no second true guideline).

Protocols and secondary analyses can outrank the primary report. When they dominate, append:

```text
NOT (protocol[ti] OR "study protocol"[tiab] OR "rationale and design"[tiab]
     OR "post hoc"[ti] OR "secondary analysis"[ti])
```

This is a precision patch, not a substitute for `[pt]`: in Q2, `[pt]` alone already put PROSEVA
first; adding the exclusion did not improve that.

### Worked example

ARDS, prone vs supine, 28-day mortality:

```jsonc
{ "queries": {
    "pubmed": "(\"Respiratory Distress Syndrome\"[MeSH] OR ARDS[tiab]) AND (\"Prone Position\"[MeSH] OR \"prone position\"[tiab] OR \"prone positioning\"[tiab]) AND (mortality[tiab]) AND (randomized controlled trial[pt])",
    "europepmc": "(TITLE_ABS:ARDS OR MESH:\"Respiratory Distress Syndrome\") AND (TITLE_ABS:\"prone position\" OR MESH:\"Prone Position\") AND (TITLE_ABS:mortality) AND PUB_TYPE:\"Randomized Controlled Trial\""
  }, "max_results": 10, "candidates": 50 }
```

Without `[pt]`, the landmark PROSEVA trial (PMID 23688302) sits below recent ECMO and protocol
papers; with it, PROSEVA is rank 1. Design filters are recall surgery, not decoration.

### PICO failure modes

- **Zero results is a finding.** Metformin + hyperbaric oxygen in FOP as a double-blind RCT returns
  0 in both PubMed and Europe PMC; loosening to `metformin AND FOP` finds two mechanistic papers,
  and `"hyperbaric oxygen" AND FOP` is still 0. Report "no direct evidence"; never assemble a
  citation from adjacent papers.
- **Old landmarks lose to recent noise** on relevance ranking (aspirin / colorectal cancer). Add
  the design filter, name the trial (`CAPP2`, `PROSEVA`), or sort by date when recency is the point.
- **"Highly cited" cannot be sorted** by PubMed relevance. Use `review[pt]` plus the canonical
  names, or mine a recent review's reference list. For a citation order, use `sort: "cited"` on
  Europe PMC (Q9 then returns the long-term aspirin follow-ups at 1,087 / 1,005 / 771 citations);
  PubMed itself has no citation sort. Greek letters (`α-synuclein`) still need a free-text variant.
- **No head-to-head RCT** (SGLT2i vs GLP-1 RA in T2DM+CKD): the honest answer is network
  meta-analysis or post-hoc analyses, not a fabricated trial.

## 3. Source syntax

### PubMed

| Tag | Meaning |
|---|---|
| `[tiab]` | title/abstract (best default) |
| `[ti]` / `[ab]` | title only / abstract only |
| `[MeSH Terms]` or `[mh]` | MeSH descriptor (exploded) |
| `[majr]` | MeSH major topic |
| `[au]` | author (`Doudna JA[au]`) |
| `[ta]` | journal abbreviation |
| `[pt]` | publication type (`review[pt]`) |
| `[dp]` | publication date (`2023:2026[dp]`) |
| `[tw]` | text words |
| `[sb]` | subset (`systematicreview[sb]`) |

Boolean operators are uppercase; quote phrases; truncate with `*` after four characters.
Find a MeSH preferred label:

```bash
curl -s 'https://id.nlm.nih.gov/mesh/lookup/descriptor?label=gene%20editing&match=contains&limit=5'
# [{"resource":".../D000072669","label":"Gene Editing"}]
```

Example:

```text
("CRISPR"[tiab] OR "Gene Editing"[MeSH Terms])
AND ("base editing"[tiab] OR "adenine base editor"[tiab])
AND ("Anemia, Sickle Cell"[MeSH Terms] OR "sickle cell"[tiab])
AND 2020:2026[dp]
```

### Europe PMC

Fields: `TITLE:`, `ABSTRACT:`, `TITLE_ABS:`, `MESH:`, `AUTH:`, `KW:`, `JOURNAL:`, `DOI:`, `PMID:`,
`PMCID:`, `EXT_ID:`, `PUB_YEAR:`, `FIRST_PDATE:[...]`, `PUB_TYPE:"review"`, `SRC:MED|PMC|PPR`,
`PUBLISHER:"bioRxiv"`, `OPEN_ACCESS:y`, `HAS_PDF:y`.

```text
(TITLE_ABS:CRISPR OR MESH:"Gene Editing")
AND (TITLE_ABS:"base editing" OR TITLE_ABS:"base editor")
AND PUB_YEAR:[2020 TO 2026]
AND (PUB_TYPE:"review" OR SRC:PPR)
```

PubMed bracket tags are invalid here — use `TITLE_ABS:` and `MESH:`.

### arXiv

Fields: `ti:`, `abs:`, `au:`, `co:`, `jr:`, `cat:`, `rn:`, `id:`, `all:`, `submittedDate:[YYYYMMDDHHMM TO ...]`.

```text
(ti:"base editing" OR abs:"base editing") AND (abs:CRISPR OR abs:CRISPR-Cas)
```

Quote an exact title for lookup: `ti:"attention is all you need"`. Useful categories: `cs.CL`,
`cs.LG`, `q-bio.QM`, `q-bio.BM`, `physics.med-ph`, `stat.ML`.

- Use stems/wildcards for recall: `abs:patholog*`, `abs:histopatholog*`, `abs:prognos*`,
  `abs:surviv*`. `pathology` alone misses `pathological` and `pathologist`.

### bioRxiv / medRxiv

Keyword search runs through the Europe PMC preprint index, so use Europe PMC syntax. The tool forces
`SRC:PPR` + `PUBLISHER`, so write only concept terms:

```jsonc
{ "queries": { "biorxiv": "TITLE_ABS:CRISPR AND TITLE_ABS:\"base editing\"" } }
```

bioRxiv's own API only enumerates by date; it has no keyword search.

## 4. Citations — `medical_literature_cite`

Inputs: one `identifier` or up to 50 `identifiers`, plus `output` and optional `save_path`.

| Output | Result |
|---|---|
| `vancouver` (default) | `Laurent M, Geoffroy M, ... Cells. 2024;13(10):800. doi:...` |
| `apa` | APA 7: `Laurent, M., ... (2024). Title. Cells, 13(10), 800. https://doi.org/...` |
| `gb-t-7714` | `LAURENT M, ... [J]. Cells, 2024, 13(10): 800. DOI:...` |
| `nature` | `Laurent, M. et al. Title. Cells 13, 800 (2024). doi:...` |
| `bibtex` | `@article{...}` / `@misc{...}` for preprints |
| `ris` | `TY  - JOUR` block for Zotero/EndNote |
| `csl-json` | CSL-JSON array for Pandoc/citeproc |

```jsonc
// One reference, quoted into a manuscript
{ "identifier": "10.3390/cells13100800", "output": "vancouver" }

// A whole reference list, saved for Zotero
{ "identifiers": ["10.3390/cells13100800", "PMID:32939066", "arXiv:1706.03762"],
  "output": "bibtex", "save_path": "refs.bib" }
```

- Metadata comes from PubMed/Europe PMC/Crossref; the tool never invents authors or years.
- `save_path` extension selects the format when `output` is omitted: `.bib`, `.ris`, `.json`, `.txt`.
  An explicit `output` that conflicts with `.bib`/`.ris`/`.json` is rejected — never write a text
  style into a machine-readable bibliography.
- Templates are standard approximations, not journal-endorsed; check a target journal's exact rules.

## 5. Full text — `medical_literature_fulltext`

Routes and realities:

| Source | Route | Status |
|---|---|---|
| PMC / Europe PMC OA (`PMCID`) | `rest/{PMCID}/fullTextXML` (JATS) | works, sections + reference list |
| arXiv | `/html/{id}` | works for papers with HTML |
| bioRxiv / medRxiv | none reliable | PDF endpoints return Cloudflare 429 |
| Paywalled journal | none | abstract only |

```jsonc
{ "identifier": "PMID: 38786024", "section": "discussion", "max_chars": 8000 }
```

- Returns a section index plus bounded text; the complete document (with references) is saved to
  `literature/<id>/fulltext.md` unless `save: false`.
- `section` filters by title; if nothing matches, all sections are returned with a note.
- Read the abstract only when full text is unavailable — never claim to have read what you did not.
- 403/429 from `europepmc.org/...pdf` or `pmc.ncbi.nlm.nih.gov/...pdf` is Cloudflare bot
  protection, not a paywall; use the XML/HTML route instead.

## 6. Evidence check — `medical_literature_check`

Use it after choosing a citation, before claiming the source supports a sentence, and to audit a
reference set.

```jsonc
{ "claim": "CRISPR-based therapy has been approved for sickle cell disease",
  "identifiers": ["PMID: 38786024"], "top_k": 3 }

// Reference-set audit only (no claim): duplicates + retractions, abstracts only
{ "identifiers": ["PMID: 38786024", "10.3390/cells13100800"], "deep": false }
```

Each returned passage carries `coverage` (fraction of the claim's distinct terms present) and
`score` (BM25). The tool also warns about duplicate references, retracted sources, polarity
mismatch (claim negated but top passage not, or vice versa), and partial/weak lexical matches.

**Read the passages; do not treat the ranking as a verdict.** This is sentence-level lexical
retrieval, not entailment. Known weak spots: acronyms (`DSB` vs `double-strand break`) and negation.
If the top passage is the opposite of the claim, treat it as "not found" and keep looking.

## 7. Polishing workflow

1. **Draft** the sentence and identify the claim that needs support.
2. **Search** with `medical_literature_search`, 20–50 candidates, per-source `queries`.
3. **Read** the best candidates' abstracts; open `medical_literature_fulltext` when the claim depends
   on a detail (effect size, methods, limitations).
4. **Cite** the chosen identifier with `medical_literature_cite` in the manuscript's style.
5. **Verify** with `medical_literature_check` (claim + identifier) and read the returned passages.
   If the full text is paywalled, say the support is abstract-level.
6. **Audit** the reference list: duplicate DOIs, preprints that have since been published.
   Records carry `retracted: true` (PubMed `PT`, Europe PMC `commentCorrectionList`) and the
   rendered head shows **RETRACTED** — never cite one without flagging it.
7. **Record** the exact per-source queries in the methods section.

## 8. Failure playbook

| Symptom | Fix |
|---|---|
| Cross-engine syntax error | Rewrite with that source's fields (`TITLE_ABS:`, `[tiab]`, `abs:`) |
| Abbreviation pulls the wrong literature | Map it first: `scripts/mesh-map.mjs "MACE"` shows nutmeg; add the expansion and a context term |
| 0 results, all sources | Drop the year filter; reduce to one concept; check field spelling |
| Huge, noisy totals | `[ti]`/`TITLE:` instead of title+abstract; add `[majr]`; add `PUB_TYPE:"review"` |
| arXiv unrelated results | Quote the exact title (`ti:"..."`) or add `cat:` |
| Full text `found: false` | Paywalled or bioRxiv/medRxiv; use the abstract and say so |
| 403/429 on a PDF | Do not scrape; use the XML/HTML route or the DOI page |
| Citation mismatch | Re-resolve the identifier with `medical_literature_get`; don't hand-edit metadata |
| `check` reports weak match / polarity | Read the passages; do not claim support from the ranking |
| `check` finds duplicates | Keep one reference; merge or remove the other |
| Method missing from top-k | Name-search (`ti:` / `all:`) or raise `candidates` |

## 9. Reporting discipline

- Cite the DOI, PMID, or arXiv id from the record — never invent one.
- State per-source totals as matches reported by the source, not as exhaustive coverage.
- Distinguish abstract-level support from full-text support.
- Report retractions and expressions of concern when the metadata exposes them.
- Keep the exact `queries` strings in the final notes for reproducibility.
