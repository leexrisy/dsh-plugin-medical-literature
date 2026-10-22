/**
 * Query planning: resolve the shared `query` and the optional per-source
 * `queries` map into exactly one query string for each requested source.
 *
 * A shared query is a convenience for free text; per-source queries are the
 * precise form, because PubMed (`[tiab]`), Europe PMC (`TITLE_ABS:`), and
 * arXiv (`abs:`) use incompatible field syntax.
 */

import { SOURCE_NAMES } from './search.js'

/** PubMed bracket tags such as `[tiab]`, `[MeSH Terms]`, `[dp]`. */
const PUBMED_TAGS = /\[\s*(?:tiab|ti|ab|mh|majr|pt|dp|tw|sb|mesh terms)\s*\]/i

/** Europe PMC colon fields such as `TITLE_ABS:`, `MESH:`, `SRC:PPR`. */
const EPMC_FIELDS =
  /\b(?:title_abs|title|abstract|mesh|pub_year|first_pdate|src|publisher|open_access|has_pdf|pub_type|auth|journal|issn|ext_id|kw)\s*:/i

/** arXiv prefixes such as `ti:`, `abs:`, `cat:`, `submittedDate:`. */
const ARXIV_FIELDS = /\b(?:ti|abs|au|co|jr|cat|rn|all|submitteddate|lastupdateddate)\s*:/i

/** The query family each source actually understands. */
const QUERY_FAMILY = {
  pubmed: 'pubmed',
  europepmc: 'europepmc',
  biorxiv: 'europepmc',
  medrxiv: 'europepmc',
  arxiv: 'arxiv',
}

const FAMILY_ADVICE = {
  pubmed: 'PubMed tags: [tiab], [MeSH Terms], [majr], [pt], [dp]',
  europepmc: 'Europe PMC fields: TITLE_ABS:, MESH:, PUB_YEAR:, SRC:PPR, PUBLISHER:',
  arxiv: 'arXiv fields: ti:, abs:, au:, cat:, submittedDate:',
}

/** Which syntax families a query string appears to use. */
function familiesOf(query) {
  const families = []
  if (PUBMED_TAGS.test(query)) families.push('pubmed')
  if (EPMC_FIELDS.test(query)) families.push('europepmc')
  if (ARXIV_FIELDS.test(query)) families.push('arxiv')
  return families
}

/** Reject a query written in another engine's field syntax. */
function assertFamily(source, query) {
  const expected = QUERY_FAMILY[source]
  const found = familiesOf(query).filter((family) => family !== expected)
  if (found.length === 0) return
  const problem = found
    .map((family) => (family === 'pubmed' ? 'PubMed bracket tags' : family === 'europepmc' ? 'Europe PMC field syntax' : 'arXiv field prefixes'))
    .join(' + ')
  throw new Error(
    `The query for source "${source}" uses ${problem}. That engine will not understand it (often returning 0 results). Rewrite it with ${FAMILY_ADVICE[expected]}, or pass per-source queries via \`queries\`.`,
  )
}

/**
 * @param {object} options
 * @param {string} [options.query] shared fallback query
 * @param {Record<string, string>} [options.queries] per-source overrides
 * @param {string[]} options.sources sources that will be searched
 * @returns {{display: string, bySource: Record<string, string>}}
 */
export function resolveQueryPlan({ query, queries, sources }) {
  const overrides = {}

  if (queries !== undefined && queries !== null) {
    if (typeof queries !== 'object' || Array.isArray(queries)) {
      throw new Error('queries must be an object mapping a source name to a query string')
    }
    for (const [source, value] of Object.entries(queries)) {
      if (!SOURCE_NAMES.includes(source)) {
        throw new Error(`queries has unknown source "${source}"; use one of: ${SOURCE_NAMES.join(', ')}`)
      }
      if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`queries.${source} must be a non-empty string`)
      }
      overrides[source] = value.trim()
    }
  }

  const fallback = typeof query === 'string' && query.trim() !== '' ? query.trim() : undefined
  if (!fallback && Object.keys(overrides).length === 0) {
    throw new Error('Provide query (shared free text) or queries (per-source syntax)')
  }

  const bySource = {}
  for (const source of sources) {
    const effective = overrides[source] ?? fallback
    if (!effective) {
      throw new Error(
        `No query for source "${source}": pass query as the shared fallback, or queries.${source}`,
      )
    }
    assertFamily(source, effective)
    bySource[source] = effective
  }

  const display = fallback ?? `per-source queries (${Object.keys(bySource).join(', ')})`
  return { display, bySource }
}
