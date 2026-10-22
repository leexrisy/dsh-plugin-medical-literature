/**
 * PubMed adapter over NCBI E-utilities.
 *
 * `esearch` selects PMIDs (JSON), then one `efetch` batch retrieves them in
 * MEDLINE text. MEDLINE is line-oriented: a field starts with `XX  - ` and
 * continuation lines are indented six spaces, which makes the parser small and
 * stable without an XML dependency.
 *
 * Set NCBI_EMAIL and (optionally) NCBI_API_KEY to lift the rate limit from
 * three to ten requests per second.
 */

import { requestJson, requestText } from '../http.js'
import { cleanText, first, normalizePmcid, toYear } from '../text.js'

const BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'
const TOOL = 'dsh-medical-literature'

const MONTHS = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
}

/** Convert a MEDLINE date (`2024 Mar 15`, `2024 Nov-Dec`, `2024`) to ISO. */
function isoDate(value) {
  if (!value) return undefined
  const match = /^(\d{4})(?:\s+([A-Za-z]{3}))?(?:\s+(\d{1,2}))?/.exec(String(value).trim())
  if (!match) return undefined
  const month = match[2] ? MONTHS[match[2].toLowerCase()] : undefined
  if (!month) return `${match[1]}-01-01`
  const day = match[3] ? Number(match[3]) : 1
  return `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function baseParams() {
  const params = new URLSearchParams({ tool: TOOL })
  if (process.env.NCBI_EMAIL) params.set('email', process.env.NCBI_EMAIL)
  if (process.env.NCBI_API_KEY) params.set('api_key', process.env.NCBI_API_KEY)
  return params
}

/** Extract the DOI from LID/AID entries such as `10.1038/x [doi]`. */
function extractDoi(lid = [], aid = []) {
  const candidates = [...lid, ...aid]
  for (const entry of candidates) {
    const match = /^\s*(10\.\d{4,9}\/\S+?)\s*(?:\[doi\])?\s*$/i.exec(entry)
    if (match) return match[1]
  }
  return undefined
}

/** Parse a MEDLINE batch into source-local records. */
export function parseMedline(text) {
  const records = []
  let fields = new Map()
  let lastKey

  const flush = () => {
    if (fields.size > 0) {
      const record = toRecord(fields)
      if (record) records.push(record)
    }
    fields = new Map()
    lastKey = undefined
  }

  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.trim() === '') {
      flush()
      continue
    }
    const field = /^([A-Z][A-Z0-9]{0,3})\s*- (.*)$/.exec(line)
    if (field) {
      lastKey = field[1]
      const values = fields.get(lastKey) ?? []
      values.push(field[2])
      fields.set(lastKey, values)
      continue
    }
    if (/^\s+/.test(line) && lastKey) {
      const values = fields.get(lastKey)
      values[values.length - 1] = `${values[values.length - 1]} ${line.trim()}`
    }
  }
  flush()

  return records
}

function toRecord(fields) {
  const pmid = first(...(fields.get('PMID') ?? []))
  if (!pmid) return undefined

  const doi = extractDoi(fields.get('LID'), fields.get('AID'))
  const pmcid = normalizePmcid(first(...(fields.get('PMC') ?? [])))
  const publicationTypes = fields.get('PT') ?? []
  const abstract = cleanText((fields.get('AB') ?? []).join(' '))
  const date = first(...(fields.get('DP') ?? []))
  const year = toYear(date)
  const journal = first(...(fields.get('JT') ?? []), ...(fields.get('TA') ?? []))
  const volume = first(...(fields.get('VI') ?? []))
  const issue = first(...(fields.get('IP') ?? []))
  const pages = first(...(fields.get('PG') ?? []))
  const iso = isoDate(date)
  const title = cleanText((fields.get('TI') ?? []).join(' '))
  const retracted = publicationTypes.some((value) => /retracted publication/i.test(value)) || /^retracted\b/i.test(title)

  return {
    source: 'pubmed',
    id: pmid,
    title,
    authors: fields.get('AU') ?? [],
    ...(retracted ? { retracted: true } : {}),
    ...(journal ? { journal } : {}),
    ...(year ? { year } : {}),
    ...(iso ? { date: iso } : {}),
    ...(volume ? { volume } : {}),
    ...(issue ? { issue } : {}),
    ...(pages ? { pages } : {}),
    ...(doi ? { doi } : {}),
    pmid,
    ...(pmcid ? { pmcid } : {}),
    ...(abstract ? { abstract } : {}),
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    ...(pmcid ? { pdf_url: `https://europepmc.org/articles/${pmcid}?pdf=render` } : {}),
    type: publicationTypes.some((value) => /review/i.test(value)) ? 'review' : 'article',
  }
}

/**
 * Retrieve records by PMID.
 * @param {string[]} ids
 * @param {AbortSignal} [signal]
 */
export async function fetchPubMedRecords(ids, signal) {
  const clean = ids.filter(Boolean)
  if (clean.length === 0) return []
  const params = baseParams()
  params.set('db', 'pubmed')
  params.set('id', clean.join(','))
  params.set('rettype', 'medline')
  params.set('retmode', 'text')
  const text = await requestText(`${BASE}/efetch.fcgi?${params}`, { signal })
  return parseMedline(text)
}

/**
 * Search PubMed.
 * @returns {Promise<{records: object[], total: number}>}
 */
export async function searchPubMed({ query, maxResults, yearFrom, yearTo, sort, signal }) {
  const params = baseParams()
  params.set('db', 'pubmed')
  params.set('term', query)
  params.set('retmax', String(maxResults))
  params.set('retmode', 'json')
  params.set('sort', sort === 'date' ? 'pub_date' : 'relevance')

  if (yearFrom || yearTo) {
    params.set('datetype', 'pdat')
    params.set('mindate', String(yearFrom ?? 1500))
    params.set('maxdate', String(yearTo ?? new Date().getFullYear()))
  }

  const payload = await requestJson(`${BASE}/esearch.fcgi?${params}`, { signal })
  const result = payload?.esearchresult
  if (!result) throw new Error('PubMed returned an unexpected esearch payload')

  const ids = Array.isArray(result.idlist) ? result.idlist : []
  const total = Number.parseInt(result.count ?? '0', 10) || 0
  if (ids.length === 0) return { records: [], total }

  return { records: await fetchPubMedRecords(ids, signal), total }
}
