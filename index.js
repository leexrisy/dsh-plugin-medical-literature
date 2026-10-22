/**
 * dsh-plugin-medical-literature
 *
 * DSH (Cordis) plugin registering five model-facing tools:
 *   - medical_literature_search: parallel PubMed / Europe PMC / arXiv /
 *     bioRxiv / medRxiv search with duplicate merging and CSV/JSON export
 *   - medical_literature_get: resolve one DOI, PMID, PMCID, or arXiv id
 *   - medical_literature_cite: format citations (Vancouver, APA, GB/T 7714,
 *     Nature, BibTeX, RIS, CSL-JSON)
 *   - medical_literature_fulltext: read open-access full text (Europe PMC JATS
 *     XML, arXiv HTML) and save it as Markdown
 *   - medical_literature_check: rank passages supporting a claim and audit a
 *     reference set for duplicates and retractions
 *
 * The plugin deliberately imports no @deepseek-ai packages: tools are
 * registered as plain objects against the enforced JSON Schema subset, so the
 * package keeps working across DSH releases without peer-version churn.
 *
 * @module dsh-plugin-medical-literature
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { buildCitations, CITE_OUTPUTS, inferOutputFromPath } from './lib/cite.js'
import { saveRecords } from './lib/export.js'
import { formatCheck, formatCitations, formatFulltext, formatRecord, formatSearch } from './lib/format.js'
import { runCheck } from './lib/check.js'
import { assembleText, fetchFulltext, sanitizeId, selectSections, toMarkdown } from './lib/fulltext.js'
import { getByIdentifier } from './lib/get.js'
import { resolveWorkspacePath } from './lib/paths.js'
import { resolveQueryPlan } from './lib/query-plan.js'
import { DEFAULT_SOURCES, FUSIONS, SOURCE_NAMES, searchAll } from './lib/search.js'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'medical-literature'

/** Only the tool registry is required; the working directory resolves optionally. */
export const inject = ['tools']

const MAX_RESULTS_CAP = 100
const DEFAULT_MAX_RESULTS = 10
const DEFAULT_ABSTRACT_CHARS = 600
const MAX_CITE_BATCH = 50

const RECORD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    source: { type: 'string', description: 'pubmed, europepmc, arxiv, biorxiv, medrxiv, or crossref' },
    id: { type: 'string' },
    title: { type: 'string' },
    authors: { type: 'array', items: { type: 'string' } },
    journal: { type: 'string' },
    year: { type: 'integer' },
    date: { type: 'string', description: 'Publication or first-release date, YYYY-MM-DD when known' },
    volume: { type: 'string' },
    issue: { type: 'string' },
    pages: { type: 'string' },
    doi: { type: 'string' },
    pmid: { type: 'string' },
    arxiv_id: { type: 'string' },
    pmcid: { type: 'string' },
    abstract: { type: 'string' },
    url: { type: 'string' },
    pdf_url: { type: 'string' },
    type: { type: 'string', description: 'article, review, or preprint' },
    retracted: { type: 'boolean', description: 'True when PubMed/Europe PMC marks the record as retracted' },
    cited_by_count: { type: 'integer', description: 'Europe PMC citation count when the source reports it' },
  },
  required: ['source', 'id', 'title', 'url'],
}

const SEARCH_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string' },
    queries: {
      type: 'object',
      additionalProperties: true,
      description: 'The exact query sent to each source, keyed by source name',
    },
    sources: { type: 'array', items: { type: 'string' } },
    candidates: { type: 'integer', description: 'Per-source recall window used before fusion' },
    fusion: { type: 'string', description: 'Fusion strategy actually applied' },
    sort: { type: 'string', description: 'Ordering requested: relevance, date, or cited' },
    counts: { type: 'object', additionalProperties: true, description: 'Records returned per source after fusion' },
    totals: { type: 'object', additionalProperties: true, description: 'Server-reported matches per source' },
    removed_duplicates: { type: 'integer' },
    records: { type: 'array', items: RECORD_SCHEMA },
    errors: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          source: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['source', 'message'],
      },
    },
    saved_to: { type: 'string' },
  },
  required: ['query', 'queries', 'sources', 'counts', 'totals', 'removed_duplicates', 'records', 'errors'],
}

const SEARCH_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: {
      type: 'string',
      description:
        'Shared search query used for every source without an entry in `queries`. Free text is adapted per source (arXiv drops English stopwords); source-native syntax is passed through. Prefer `queries` when field-level precision matters.',
    },
    queries: {
      type: 'object',
      additionalProperties: true,
      description:
        'Per-source queries, keyed by source name (pubmed, europepmc, arxiv, biorxiv, medrxiv). Values are sent verbatim, so each source can use its own field syntax, e.g. pubmed: "(CRISPR[tiab] OR \\"Gene Editing\\"[MeSH Terms]) AND 2023:2026[dp]", europepmc: "TITLE_ABS:CRISPR AND MESH:\\"Gene Editing\\" AND PUB_YEAR:[2023 TO 2026]", arxiv: "(abs:CRISPR OR abs:\\"gene editing\\") AND cat:q-bio.QM". Sources listed here are searched even when `sources` is omitted.',
    },
    sources: {
      type: 'array',
      items: { type: 'string', enum: SOURCE_NAMES },
      description: `Sources to search. Default: ${DEFAULT_SOURCES.join(', ')} when only \`query\` is given, otherwise the keys of \`queries\`. bioRxiv/medRxiv search uses the Europe PMC preprint index.`,
    },
    max_results: {
      type: 'integer',
      description: `Final results across all sources, 1-${MAX_RESULTS_CAP}. Default ${DEFAULT_MAX_RESULTS}.`,
    },
    candidates: {
      type: 'integer',
      description: `Per-source recall window before fusion, 1-${MAX_RESULTS_CAP}. Default max(20, 3x max_results). Raise it when the paper you expect sits below the source's top ${DEFAULT_MAX_RESULTS}.`,
    },
    fusion: {
      type: 'string',
      enum: FUSIONS,
      description:
        'How to combine the sources\' own ranked lists. rrf (default): reciprocal rank fusion, uses only each engine\'s ranks; source: keep source blocks in order; bm25: local term-frequency re-rank (opt-in, ignores MeSH/citation/recency signals).',
    },
    year_from: {
      type: 'integer',
      description: 'Earliest publication year, inclusive.',
    },
    year_to: {
      type: 'integer',
      description: 'Latest publication year, inclusive.',
    },
    sort: {
      type: 'string',
      enum: ['relevance', 'date', 'cited'],
      description:
        'relevance (default), date (newest first), or cited (highest citation count first; Europe PMC only, so request it alone).',
    },
    abstract_chars: {
      type: 'integer',
      description: `Abstract excerpt length in the rendered result; 0 omits abstracts. Default ${DEFAULT_ABSTRACT_CHARS}. Full abstracts are still exported.`,
    },
    save_path: {
      type: 'string',
      description:
        'Optional path to write every merged record to. Extension selects the format: .csv, .json, or .jsonl. Relative paths resolve against the session working directory.',
    },
  },
}

const GET_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    found: { type: 'boolean' },
    record: RECORD_SCHEMA,
    message: { type: 'string' },
  },
  required: ['found'],
}

const GET_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    identifier: {
      type: 'string',
      description:
        'DOI (10.xxxx/...), PMID (digits), PMCID (PMC...), arXiv id (2401.12345), or a doi.org / pubmed / arXiv URL.',
    },
  },
  required: ['identifier'],
}

const CITE_ENTRY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    identifier: { type: 'string' },
    id: { type: 'string' },
    title: { type: 'string' },
    source: { type: 'string' },
    text: { type: 'string' },
  },
  required: ['identifier', 'text'],
}

const CITE_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    output: { type: 'string' },
    count: { type: 'integer' },
    entries: { type: 'array', items: CITE_ENTRY_SCHEMA },
    combined: { type: 'string' },
    failures: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          identifier: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['identifier', 'message'],
      },
    },
    saved_to: { type: 'string' },
  },
  required: ['output', 'count', 'entries', 'combined'],
}

const CITE_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    identifier: {
      type: 'string',
      description: 'One DOI, PMID, PMCID, or arXiv id.',
    },
    identifiers: {
      type: 'array',
      items: { type: 'string' },
      description: `Multiple identifiers (up to ${MAX_CITE_BATCH}) formatted as one bibliography.`,
    },
    output: {
      type: 'string',
      enum: CITE_OUTPUTS,
      description:
        'Output format. Text styles: vancouver (default), apa, gb-t-7714, nature. Reference-manager formats: bibtex, ris, csl-json. Inferred from save_path when omitted.',
    },
    save_path: {
      type: 'string',
      description:
        'Optional file to write the bibliography to. .bib/.ris/.json select bibtex/ris/csl-json automatically; .txt/.md keep the text style.',
    },
  },
}

const FULLTEXT_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    found: { type: 'boolean' },
    id: { type: 'string' },
    source: { type: 'string', description: 'europepmc-xml or arxiv-html' },
    title: { type: 'string' },
    doi: { type: 'string' },
    pmid: { type: 'string' },
    pmcid: { type: 'string' },
    arxiv_id: { type: 'string' },
    url: { type: 'string' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          level: { type: 'integer' },
          chars: { type: 'integer' },
        },
        required: ['title', 'level', 'chars'],
      },
    },
    text: { type: 'string' },
    truncated: { type: 'boolean' },
    references_count: { type: 'integer' },
    saved_to: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['found'],
}

const FULLTEXT_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    identifier: {
      type: 'string',
      description: 'DOI, PMID, PMCID, arXiv id, or a doi.org / pubmed / arXiv URL.',
    },
    section: {
      type: 'string',
      description:
        'Optional case-insensitive section-title filter (e.g. "methods", "discussion"). When nothing matches, all sections are returned with a note.',
    },
    max_chars: {
      type: 'integer',
      description: 'Maximum characters of section text returned to the model, 500-50000. Default 12000. The complete document is saved to disk.',
    },
    save: {
      type: 'boolean',
      description: 'Save the complete document as Markdown; default true.',
    },
    save_path: {
      type: 'string',
      description: 'Optional explicit Markdown path. Default: literature/<id>/fulltext.md under the session working directory.',
    },
  },
  required: ['identifier'],
}

const CHECK_PASSAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    section: { type: 'string' },
    text: { type: 'string' },
    score: { type: 'number' },
    coverage: { type: 'number', description: 'Fraction of distinct claim terms present in the passage' },
  },
  required: ['section', 'text', 'score', 'coverage'],
}

const CHECK_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    identifier: { type: 'string' },
    found: { type: 'boolean' },
    id: { type: 'string' },
    title: { type: 'string' },
    year: { type: 'integer' },
    journal: { type: 'string' },
    doi: { type: 'string' },
    pmid: { type: 'string' },
    pmcid: { type: 'string' },
    arxiv_id: { type: 'string' },
    retracted: { type: 'boolean' },
    evidence_source: { type: 'string', description: 'europepmc-xml, arxiv-html, abstract, or none' },
    passages: { type: 'array', items: CHECK_PASSAGE_SCHEMA },
    message: { type: 'string' },
  },
  required: ['identifier', 'found'],
}

const CHECK_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    claim: { type: 'string' },
    checked: { type: 'integer' },
    items: { type: 'array', items: CHECK_ITEM_SCHEMA },
    duplicates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', description: 'doi or title' },
          value: { type: 'string' },
          identifiers: { type: 'array', items: { type: 'string' } },
        },
        required: ['kind', 'value', 'identifiers'],
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['checked', 'items', 'duplicates', 'warnings'],
}

const CHECK_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    claim: {
      type: 'string',
      description:
        'The sentence or claim to check against the cited source(s). Omit it to only audit the reference list for duplicates and retractions.',
    },
    identifier: { type: 'string', description: 'One DOI, PMID, PMCID, or arXiv id.' },
    identifiers: {
      type: 'array',
      items: { type: 'string' },
      description: 'Up to 10 identifiers to check as one reference set.',
    },
    top_k: {
      type: 'integer',
      description: 'Passages to return per source, 1-5. Default 3.',
    },
    deep: {
      type: 'boolean',
      description:
        'Fetch open-access full text when available (default true); false checks abstracts only and is faster.',
    },
  },
}

function readString(args, key, { required = false, fallback, maxLength = 4000 } = {}) {
  const value = args?.[key]
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    if (required) throw new Error(`${key} is required`)
    return fallback
  }
  if (typeof value !== 'string') throw new Error(`${key} must be a string`)
  if (value.length > maxLength) throw new Error(`${key} must be at most ${maxLength} characters`)
  return value.trim()
}

function readInteger(args, key, { min, max, fallback } = {}) {
  const value = args?.[key]
  if (value === undefined || value === null) return fallback
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(number)) throw new Error(`${key} must be an integer`)
  if (min !== undefined && number < min) throw new Error(`${key} must be at least ${min}`)
  if (max !== undefined && number > max) throw new Error(`${key} must be at most ${max}`)
  return number
}

function readBoolean(args, key, fallback) {
  const value = args?.[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`)
  return value
}

function readSources(args) {
  const value = args?.sources
  if (value === undefined || value === null) return [...DEFAULT_SOURCES]
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('sources must be a non-empty array')
  }
  const unique = []
  for (const item of value) {
    if (typeof item !== 'string' || !SOURCE_NAMES.includes(item)) {
      throw new Error(`sources must contain only: ${SOURCE_NAMES.join(', ')}`)
    }
    if (!unique.includes(item)) unique.push(item)
  }
  return unique
}

function readSort(args) {
  const value = args?.sort
  if (value === undefined || value === null) return 'relevance'
  if (value !== 'relevance' && value !== 'date' && value !== 'cited') {
    throw new Error('sort must be "relevance", "date", or "cited"')
  }
  return value
}

function readFusion(args) {
  const value = args?.fusion
  if (value === undefined || value === null) return 'rrf'
  if (!FUSIONS.includes(value)) {
    throw new Error(`fusion must be one of: ${FUSIONS.join(', ')}`)
  }
  return value
}

/** Accept one identifier or a batch, deduplicated, capped. */
function readIdentifiers(args, limit = MAX_CITE_BATCH) {
  const list = []
  const single = readString(args, 'identifier', { maxLength: 1000 })
  if (single) list.push(single)

  const many = args?.identifiers
  if (many !== undefined && many !== null) {
    if (!Array.isArray(many) || many.length === 0) {
      throw new Error('identifiers must be a non-empty array')
    }
    for (const item of many) {
      if (typeof item !== 'string' || item.trim() === '') {
        throw new Error('identifiers must contain non-empty strings')
      }
      list.push(item.trim())
    }
  }

  const unique = [...new Set(list)]
  if (unique.length === 0) throw new Error('Provide identifier or identifiers')
  if (unique.length > limit) {
    throw new Error(`At most ${limit} identifiers per call`)
  }
  return unique
}

function readCitationOutput(args, savePath) {
  const explicit = readString(args, 'output')
  if (explicit !== undefined && !CITE_OUTPUTS.includes(explicit)) {
    throw new Error(`output must be one of: ${CITE_OUTPUTS.join(', ')}`)
  }

  // A .bib/.ris/.json path promises a machine-readable bibliography; writing
  // Vancouver text into it would silently corrupt the file.
  const lower = String(savePath ?? '').toLowerCase()
  const required = lower.endsWith('.bib')
    ? 'bibtex'
    : lower.endsWith('.ris')
      ? 'ris'
      : lower.endsWith('.json')
        ? 'csl-json'
        : undefined
  if (required && explicit !== undefined && explicit !== required) {
    throw new Error(
      `save_path "${savePath}" implies ${required}, but output is "${explicit}". Use output: "${required}" or a .txt/.md path.`,
    )
  }

  if (explicit !== undefined) return explicit
  return (savePath ? inferOutputFromPath(savePath) : undefined) ?? 'vancouver'
}

function abstractCharsOf(args) {
  const value = Number(args?.abstract_chars)
  return Number.isFinite(value) ? Math.max(0, value) : DEFAULT_ABSTRACT_CHARS
}

/**
 * Register the medical literature tools in the mounting scope.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.tools.register({
    name: 'medical_literature_search',
    description:
      'Search biomedical and preprint literature in parallel across PubMed, Europe PMC, arXiv, bioRxiv, and medRxiv. Pass `query` for shared free text, or `queries` to give each source its own native syntax (PubMed [tiab]/[MeSH Terms], Europe PMC TITLE_ABS:/MESH:/PUB_YEAR:, arXiv ti:/abs:/cat:). Preserves the native ranking of each source and combines lists with reciprocal rank fusion by default (`fusion: rrf`; `source` keeps blocks, `bm25` is opt-in local re-ranking). Returns deduplicated records with title, authors, venue, year, DOI/PMID/arXiv id, abstract excerpt, and links; optionally exports to CSV, JSON, or JSONL. Load the `medical-literature` skill for per-source syntax and review-grade query recipes.',
    parameters: SEARCH_PARAMETERS,
    output: {
      schema: SEARCH_OUTPUT,
      render: (args, value) => [
        { type: 'text', text: formatSearch(value, abstractCharsOf(args)) },
      ],
    },
    timeoutMs: 180_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const query = readString(args, 'query', { maxLength: 2000 })
      const explicitSources = Array.isArray(args?.sources) && args.sources.length > 0
      let sources
      if (explicitSources) {
        sources = readSources(args)
      } else if (query) {
        sources = [...DEFAULT_SOURCES]
      } else {
        sources = Object.keys(args?.queries ?? {})
        if (sources.length === 0) throw new Error('Provide query (shared free text) or queries (per-source syntax)')
      }

      const plan = resolveQueryPlan({ query, queries: args?.queries, sources })
      const maxResults = readInteger(args, 'max_results', {
        min: 1,
        max: MAX_RESULTS_CAP,
        fallback: DEFAULT_MAX_RESULTS,
      })
      const candidates = readInteger(args, 'candidates', {
        min: 1,
        max: MAX_RESULTS_CAP,
        fallback: Math.min(MAX_RESULTS_CAP, Math.max(20, maxResults * 3)),
      })
      const fusion = readFusion(args)
      const yearFrom = readInteger(args, 'year_from', { min: 1500, max: 2200 })
      const yearTo = readInteger(args, 'year_to', { min: 1500, max: 2200 })
      if (yearFrom !== undefined && yearTo !== undefined && yearFrom > yearTo) {
        throw new Error('year_from must not be greater than year_to')
      }
      const sort = readSort(args)
      if (sort === 'cited' && (sources.length !== 1 || sources[0] !== 'europepmc')) {
        throw new Error(
          'sort "cited" is available only from Europe PMC. Call it alone: sources: ["europepmc"]. ' +
            'For classic + frontier coverage, run a second search with PubMed and sort "date" or "relevance".',
        )
      }
      readInteger(args, 'abstract_chars', { min: 0, max: 20_000, fallback: DEFAULT_ABSTRACT_CHARS })
      const savePath = readString(args, 'save_path', { maxLength: 1000 })

      const outcome = await searchAll({
        queries: plan.bySource,
        maxResults: candidates,
        finalMaxResults: maxResults,
        fusion,
        yearFrom,
        yearTo,
        sort,
        signal: exec.signal,
      })

      const value = {
        query: plan.display,
        queries: plan.bySource,
        sources,
        candidates,
        fusion: outcome.fusion,
        sort,
        counts: outcome.counts,
        totals: outcome.totals,
        removed_duplicates: outcome.removedDuplicates,
        records: outcome.records,
        errors: outcome.errors,
      }

      if (savePath) {
        const resolved = await resolveWorkspacePath(ctx, exec, savePath)
        value.saved_to = await saveRecords(outcome.records, resolved)
      }

      return value
    },
  })

  ctx.tools.register({
    name: 'medical_literature_get',
    description:
      'Resolve one medical literature record from a DOI, PMID, PMCID, arXiv id, or a doi.org / pubmed / arXiv URL. Returns full metadata (including volume, issue, and pages) and the complete abstract, falling back from PubMed to Europe PMC and Crossref.',
    parameters: GET_PARAMETERS,
    output: {
      schema: GET_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: formatRecord(value) }],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const identifier = readString(args, 'identifier', { required: true, maxLength: 1000 })
      return getByIdentifier({ identifier, signal: exec.signal })
    },
  })

  ctx.tools.register({
    name: 'medical_literature_cite',
    description:
      'Format citations for medical papers from DOI, PMID, PMCID, or arXiv id. Outputs Vancouver, APA 7, GB/T 7714-2015, Nature, BibTeX, RIS, or CSL-JSON, batches up to 50 references, and optionally writes a .bib/.ris/.json bibliography. Use this when polishing a manuscript and inserting references; metadata comes from PubMed, Europe PMC, and Crossref rather than being generated.',
    parameters: CITE_PARAMETERS,
    output: {
      schema: CITE_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: formatCitations(value) }],
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const identifiers = readIdentifiers(args)
      const savePath = readString(args, 'save_path', { maxLength: 1000 })
      const output = readCitationOutput(args, savePath)

      const items = []
      const failures = []
      for (const identifier of identifiers) {
        const resolved = await getByIdentifier({ identifier, signal: exec.signal })
        if (resolved.found && resolved.record) items.push({ identifier, record: resolved.record })
        else failures.push({ identifier, message: resolved.message ?? 'No record found.' })
      }

      if (items.length === 0) {
        throw new Error(
          `No citations resolved:\n${failures.map((failure) => `- ${failure.identifier}: ${failure.message}`).join('\n')}`,
        )
      }

      const { entries, combined } = buildCitations(items, output)
      const value = {
        output,
        count: entries.length,
        entries,
        combined,
        ...(failures.length > 0 ? { failures } : {}),
      }

      if (savePath) {
        const resolved = await resolveWorkspacePath(ctx, exec, savePath)
        await mkdir(dirname(resolved), { recursive: true })
        await writeFile(resolved, `${combined}\n`, 'utf8')
        value.saved_to = resolved
      }

      return value
    },
  })

  ctx.tools.register({
    name: 'medical_literature_fulltext',
    description:
      'Read the open-access full text of a medical paper (DOI, PMID, PMCID, arXiv id, or URL). Uses Europe PMC JATS XML for PMC articles and arXiv HTML for preprints, returns a section index plus a bounded text excerpt, and saves the complete document as Markdown under literature/<id>/. Paywalled articles and bioRxiv/medRxiv preprints have no full-text route and report that explicitly.',
    parameters: FULLTEXT_PARAMETERS,
    output: {
      schema: FULLTEXT_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: formatFulltext(value) }],
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const identifier = readString(args, 'identifier', { required: true, maxLength: 1000 })
      const maxChars = readInteger(args, 'max_chars', { min: 500, max: 50_000, fallback: 12_000 })
      const section = readString(args, 'section', { maxLength: 200 })
      const save = readBoolean(args, 'save', true)
      const savePath = readString(args, 'save_path', { maxLength: 1000 })

      const result = await fetchFulltext({ identifier, signal: exec.signal })
      if (!result.found) {
        return {
          found: false,
          ...(result.id ? { id: result.id } : {}),
          ...(result.doi ? { doi: result.doi } : {}),
          ...(result.pmid ? { pmid: result.pmid } : {}),
          ...(result.pmcid ? { pmcid: result.pmcid } : {}),
          ...(result.arxiv_id ? { arxiv_id: result.arxiv_id } : {}),
          ...(result.url ? { url: result.url } : {}),
          message: result.message,
        }
      }

      const selected = selectSections(result.sections, section)
      const { text, truncated } = assembleText(selected.sections, maxChars)
      const referencesCount = result.referencesCount ?? result.references.length

      const value = {
        found: true,
        id: result.id,
        source: result.source,
        title: result.title,
        ...(result.doi ? { doi: result.doi } : {}),
        ...(result.pmid ? { pmid: result.pmid } : {}),
        ...(result.pmcid ? { pmcid: result.pmcid } : {}),
        ...(result.arxiv_id ? { arxiv_id: result.arxiv_id } : {}),
        ...(result.url ? { url: result.url } : {}),
        sections: selected.sections.map((entry) => ({
          title: entry.title,
          level: entry.level,
          chars: entry.text.length,
        })),
        text,
        truncated,
        references_count: referencesCount,
        ...(selected.matched
          ? {}
          : { message: `No section title matched "${section}"; all sections were returned.` }),
      }

      if (save) {
        const target = savePath
          ? await resolveWorkspacePath(ctx, exec, savePath)
          : await resolveWorkspacePath(ctx, exec, `literature/${sanitizeId(result.id)}/fulltext.md`)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, toMarkdown(result), 'utf8')
        value.saved_to = target
      }

      return value
    },
  })

  ctx.tools.register({
    name: 'medical_literature_check',
    description:
      'Check whether cited sources support a claim and audit a reference set. Resolves 1-10 identifiers, optionally reads open-access full text, and returns the highest-scoring passages per source (BM25 + claim-term coverage), plus duplicate and retraction warnings. This is lexical passage retrieval, not semantic entailment: read the returned passages before relying on them.',
    parameters: CHECK_PARAMETERS,
    output: {
      schema: CHECK_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: formatCheck(value) }],
    },
    timeoutMs: 240_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const claim = readString(args, 'claim', { maxLength: 2000 })
      const identifiers = readIdentifiers(args, 10)
      const topK = readInteger(args, 'top_k', { min: 1, max: 5, fallback: 3 })
      const deep = readBoolean(args, 'deep', true)
      return runCheck({ claim, identifiers, topK, deep, signal: exec.signal })
    },
  })
}
