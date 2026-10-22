/**
 * arXiv adapter over the public Atom API.
 *
 * The API has no JSON mode, so this module parses the small, stable slice of
 * Atom that arXiv emits. Free-text queries are rewritten into `all:` terms;
 * anything that already looks like arXiv query syntax is passed through.
 */

import { requestText } from '../http.js'
import { cleanText, decodeEntities, toYear } from '../text.js'

const BASE = 'https://export.arxiv.org/api/query'

/** Fields the arXiv API recognises before a colon. */
const ARXIV_FIELD = /(?:^|\s)(?:all|ti|au|abs|co|jr|cat|rn|id|doi|submittedDate|lastUpdatedDate)\s*:/i
const ARXIV_BOOLEAN = /\b(?:AND|OR|ANDNOT)\b/

/**
 * English function words. arXiv joins `all:` terms with AND, so leaving these
 * in turns a natural-language query into a zero-result search.
 */
const STOPWORDS = new Set(
  `a an and are as at be been but by can could do does for from had has have how if in into is it its may
   might more most must not of on or our shall should such than that the their them then there these they
   this those to was we were what when where which while who will with would you your`
    .split(/\s+/)
    .filter(Boolean),
)

function tokenize(value) {
  return value.match(/"[^"]+"|\S+/g) ?? [value]
}

/** Remove English function words while keeping quoted phrases intact. */
function meaningfulTerms(value) {
  return tokenize(value).filter((token) => {
    if (token.startsWith('"')) return true
    const word = token.toLowerCase().replace(/[^\p{L}\p{N}-]/gu, '')
    return word.length > 0 && !STOPWORDS.has(word)
  })
}

/**
 * Turn free text into an arXiv query; pass recognised syntax through.
 *
 * Recognised field prefixes (`ti:`, `abs:`, ...) and boolean operators are
 * preserved verbatim. Otherwise each word becomes an `all:` term joined by
 * AND, with English function words removed and quoted phrases kept intact.
 */
export function buildArxivQuery(query) {
  const value = String(query).trim()
  if (!value) throw new Error('arXiv query is empty')
  if (ARXIV_FIELD.test(value) || ARXIV_BOOLEAN.test(value)) return value

  const meaningful = meaningfulTerms(value)
  const chosen = meaningful.length > 0 ? meaningful : tokenize(value)
  return chosen.map((term) => `all:${term}`).join(' AND ')
}

function withDateFilter(query, yearFrom, yearTo) {
  if (!yearFrom && !yearTo) return query
  const from = `${yearFrom ?? 1500}01010000`
  const to = `${yearTo ?? new Date().getFullYear()}12312359`
  return `(${query}) AND submittedDate:[${from} TO ${to}]`
}

/** Read one field from an Atom entry block. */
function tag(block, tagName) {
  const match = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'i').exec(block)
  return match ? decodeEntities(match[1]).replace(/\s+/g, ' ').trim() : undefined
}

/** Parse `<link .../>` elements into attribute maps. */
function links(block) {
  const found = []
  const pattern = /<link\b([^>]*?)\/?>/gi
  let match
  while ((match = pattern.exec(block)) !== null) {
    const attributes = {}
    const attributePattern = /([a-z-]+)\s*=\s*"([^"]*)"/gi
    let attribute
    while ((attribute = attributePattern.exec(match[1])) !== null) {
      attributes[attribute[1].toLowerCase()] = decodeEntities(attribute[2])
    }
    found.push(attributes)
  }
  return found
}

function toRecord(block) {
  const rawId = tag(block, 'id') ?? ''
  const idMatch = /((?:\d{4}\.\d{4,5})|(?:[a-z-]+(?:\.[a-z]{2})?\/\d{7}))(v\d+)?/i.exec(rawId)
  const arxivId = idMatch ? `${idMatch[1]}${idMatch[2] ?? ''}` : rawId
  const baseId = idMatch ? idMatch[1] : arxivId
  const published = tag(block, 'published')
  const doi = tag(block, 'arxiv:doi')
  const journalRef = tag(block, 'arxiv:journal_ref')
  const authors = []
  const authorPattern = /<author>([\s\S]*?)<\/author>/gi
  let authorMatch
  while ((authorMatch = authorPattern.exec(block)) !== null) {
    const name = tag(authorMatch[1], 'name')
    if (name) authors.push(name)
  }

  const entryLinks = links(block)
  const pdfLink = entryLinks.find((entry) => entry.title === 'pdf') ?? entryLinks.find((entry) => /\/pdf\//.test(entry.href ?? ''))
  const absLink = entryLinks.find((entry) => entry.rel === 'alternate') ?? entryLinks.find((entry) => /\/abs\//.test(entry.href ?? ''))
  const year = toYear(published)

  return {
    source: 'arxiv',
    id: arxivId,
    arxiv_id: arxivId,
    title: cleanText(tag(block, 'title') ?? ''),
    ...(authors.length > 0 ? { authors } : {}),
    ...(journalRef ? { journal: journalRef } : {}),
    ...(year ? { year } : {}),
    ...(published ? { date: String(published).slice(0, 10) } : {}),
    ...(doi ? { doi } : {}),
    ...(tag(block, 'summary') ? { abstract: cleanText(tag(block, 'summary')) } : {}),
    url: `https://arxiv.org/abs/${baseId}`,
    ...(pdfLink?.href ? { pdf_url: pdfLink.href.replace(/^http:/, 'https:') } : {}),
    type: 'preprint',
  }
}

/** Parse an arXiv Atom feed; throws when arXiv itself reports a query error. */
export function parseArxivFeed(xml) {
  const text = String(xml ?? '')
  const totalMatch = /<opensearch:totalResults[^>]*>(\d+)<\/opensearch:totalResults>/i.exec(text)
  const total = totalMatch ? Number.parseInt(totalMatch[1], 10) : 0

  const entries = []
  const entryPattern = /<entry>([\s\S]*?)<\/entry>/gi
  let match
  while ((match = entryPattern.exec(text)) !== null) {
    const block = match[1]
    const title = cleanText(tag(block, 'title') ?? '')
    if (/^error$/i.test(title)) {
      throw new Error(`arXiv rejected the query: ${cleanText(tag(block, 'summary') ?? '')}`)
    }
    entries.push(toRecord(block))
  }

  return { records: entries, total }
}

/** Run one Atom query and parse it. */
async function requestFeed(searchQuery, maxResults, sort, signal) {
  const params = new URLSearchParams({
    search_query: searchQuery,
    start: '0',
    max_results: String(Math.min(maxResults, 100)),
    sortBy: sort === 'date' ? 'submittedDate' : 'relevance',
    sortOrder: 'descending',
  })
  const xml = await requestText(`${BASE}?${params}`, { signal })
  return parseArxivFeed(xml)
}

/** Base arXiv id without the version suffix. */
function baseId(record) {
  return String(record?.arxiv_id ?? record?.id ?? '').replace(/v\d+$/, '')
}

/**
 * Search arXiv.
 *
 * Free text is ANDed after stopword removal. arXiv's relevance ranking does
 * not reward an exact title match in that form, so a query of four or more
 * words also probes `ti:"<the whole query>"` and puts exact title matches
 * first; the broader AND results fill the remaining slots.
 *
 * @returns {Promise<{records: object[], total: number}>}
 */
export async function searchArxiv({ query, maxResults, yearFrom, yearTo, sort, signal }) {
  const value = String(query).trim()
  const explicit = ARXIV_FIELD.test(value) || ARXIV_BOOLEAN.test(value)
  const broadQuery = withDateFilter(buildArxivQuery(value), yearFrom, yearTo)

  if (explicit || sort === 'date') {
    return requestFeed(broadQuery, maxResults, sort, signal)
  }

  const tokens = tokenize(value)
  if (tokens.length < 4) {
    return requestFeed(broadQuery, maxResults, sort, signal)
  }

  const phrase = value.replace(/"/g, ' ').replace(/\s+/g, ' ').trim()
  let probe = { records: [], total: 0 }
  try {
    probe = await requestFeed(
      withDateFilter(`ti:"${phrase}"`, yearFrom, yearTo),
      maxResults,
      sort,
      signal,
    )
  } catch {
    // A phrase probe that arXiv cannot parse must not lose the broad search.
  }

  const broad = await requestFeed(broadQuery, maxResults, sort, signal)
  const seen = new Set()
  const records = []
  for (const record of [...probe.records, ...broad.records]) {
    const key = baseId(record)
    if (seen.has(key)) continue
    seen.add(key)
    records.push(record)
    if (records.length >= maxResults) break
  }

  return { records, total: Math.max(probe.total, broad.total) }
}

/** Retrieve one arXiv entry by identifier. */
export async function fetchArxivById(id, signal) {
  const params = new URLSearchParams({ id_list: id, max_results: '1' })
  const xml = await requestText(`${BASE}?${params}`, { signal })
  const { records } = parseArxivFeed(xml)
  return records[0]
}
