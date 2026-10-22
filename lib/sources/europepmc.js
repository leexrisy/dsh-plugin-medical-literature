/**
 * Europe PMC adapter over its REST search endpoint.
 *
 * Europe PMC indexes MEDLINE/PubMed, PMC full text, preprints, patents, and
 * Agricola. The same endpoint powers the bioRxiv and medRxiv tools: those
 * preprints live under `SRC:PPR` with a `PUBLISHER` filter, which is the only
 * reliable keyword-search route because bioRxiv's own API is date-based.
 */

import { requestJson } from '../http.js'
import { cleanText, first, normalizePmcid, toYear } from '../text.js'

const BASE = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search'

/** Preprint publisher names accepted by the Europe PMC `PUBLISHER` field. */
export const PREPRINT_PUBLISHERS = {
  biorxiv: 'bioRxiv',
  medrxiv: 'medRxiv',
}

/** Choose the best open-access PDF URL a core record exposes. */
function pickPdfUrl(record, pmcid) {
  const urls = Array.isArray(record?.fullTextUrlList?.fullTextUrl)
    ? record.fullTextUrlList.fullTextUrl
    : []
  const freePdf = urls.find(
    (entry) => entry?.documentStyle === 'pdf' && String(entry?.availabilityCode ?? '').toUpperCase() === 'F',
  )
  const anyPdf = urls.find((entry) => entry?.documentStyle === 'pdf')
  const direct = freePdf?.url ?? anyPdf?.url
  if (direct) return direct
  return pmcid ? `https://europepmc.org/articles/${pmcid}?pdf=render` : undefined
}

function toRecord(record, source) {
  const pmid = record.pmid ? String(record.pmid) : undefined
  const doi = record.doi ? String(record.doi) : undefined
  const pmcid = normalizePmcid(record.pmcid)
  const year = toYear(record.pubYear)
  const abstract = cleanText(record.abstractText)
  const journal = first(
    record?.journalInfo?.journal?.title,
    record.journalTitle,
    record?.bookOrReportDetails?.publisher,
  )
  const pubTypes = Array.isArray(record?.pubTypeList?.pubType) ? record.pubTypeList.pubType : []
  const isPreprint = String(record.source ?? '').toUpperCase() === 'PPR' || pubTypes.includes('Preprint')

  const authors = String(record.authorString ?? '')
    .split(/,\s*/)
    .map((name) => name.trim())
    .filter(Boolean)

  const date = record.firstPublicationDate ?? record.electronicPublicationDate ?? undefined
  const pdfUrl = pickPdfUrl(record, pmcid)
  const volume = record?.journalInfo?.volume
  const issue = record?.journalInfo?.issue
  const pages = record?.pageInfo
  const title = cleanText(record.title)
  const corrections = Array.isArray(record?.commentCorrectionList?.commentCorrection)
    ? record.commentCorrectionList.commentCorrection
    : []
  const retracted =
    corrections.some((entry) => /retraction in/i.test(String(entry?.type ?? ''))) || /^retracted\b/i.test(title)
  const citedByCount = Number(record.citedByCount)

  return {
    source,
    id: pmid ?? String(record.id ?? doi ?? ''),
    title,
    ...(retracted ? { retracted: true } : {}),
    ...(Number.isFinite(citedByCount) && record.citedByCount !== undefined
      ? { cited_by_count: citedByCount }
      : {}),
    ...(authors.length > 0 ? { authors } : {}),
    ...(journal ? { journal } : {}),
    ...(year ? { year } : {}),
    ...(date ? { date } : {}),
    ...(volume ? { volume: String(volume) } : {}),
    ...(issue ? { issue: String(issue) } : {}),
    ...(pages ? { pages: String(pages) } : {}),
    ...(doi ? { doi } : {}),
    ...(pmid ? { pmid } : {}),
    ...(pmcid ? { pmcid } : {}),
    ...(abstract ? { abstract } : {}),
    url:
      `https://europepmc.org/article/${record.source ?? 'MED'}/${record.id ?? pmid ?? ''}`.replace(/\/$/, ''),
    ...(pdfUrl ? { pdf_url: pdfUrl } : {}),
    type: isPreprint ? 'preprint' : pubTypes.some((value) => /review/i.test(value)) ? 'review' : 'article',
  }
}

/**
 * Search Europe PMC.
 *
 * @param {object} options
 * @param {string} options.query free text or Europe PMC field syntax
 * @param {number} options.maxResults per-source cap
 * @param {number} [options.yearFrom]
 * @param {number} [options.yearTo]
 * @param {'relevance'|'date'|'cited'} [options.sort]
 * @param {'biorxiv'|'medrxiv'} [options.preprint] restrict to one preprint server
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{records: object[], total: number}>}
 */
export async function searchEuropePmc({
  query,
  maxResults,
  yearFrom,
  yearTo,
  sort,
  preprint,
  signal,
}) {
  let expression = String(query).trim()
  if (!expression) throw new Error('Europe PMC query is empty')

  const publisher = preprint ? PREPRINT_PUBLISHERS[preprint] : undefined
  if (publisher) {
    expression = `(${expression}) AND (SRC:PPR) AND (PUBLISHER:"${publisher}")`
  }

  if (yearFrom || yearTo) {
    const from = yearFrom ?? 1500
    const to = yearTo ?? new Date().getFullYear()
    expression = `(${expression}) AND (PUB_YEAR:[${from} TO ${to}])`
  }

  const params = new URLSearchParams({
    query: expression,
    format: 'json',
    pageSize: String(Math.min(maxResults, 1000)),
    resultType: 'core',
  })
  if (sort === 'date') params.set('sort', 'P_PDATE_D desc')
  if (sort === 'cited') params.set('sort', 'CITED desc')

  const payload = await requestJson(`${BASE}?${params}`, { signal })
  const total = Number.parseInt(payload?.hitCount ?? '0', 10) || 0
  const results = Array.isArray(payload?.resultList?.result) ? payload.resultList.result : []
  const source = preprint ?? 'europepmc'

  return { records: results.map((record) => toRecord(record, source)), total }
}
