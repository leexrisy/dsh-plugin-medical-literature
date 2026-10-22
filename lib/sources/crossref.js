/**
 * Crossref resolver used as a DOI fallback when Europe PMC has no record
 * (for example chemistry, physics, and social-science DOIs). Crossref is not
 * offered as a search source; it resolves a known DOI into metadata.
 */

import { requestJson } from '../http.js'
import { cleanText, first, toYear } from '../text.js'

function dateParts(message) {
  const candidates = [
    message?.['published-print'],
    message?.['published-online'],
    message?.issued,
    message?.created,
  ]
  for (const candidate of candidates) {
    const parts = candidate?.['date-parts']?.[0]
    if (Array.isArray(parts) && parts.length > 0) {
      const [year, month = 1, day = 1] = parts
      return { year: Number(year), date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` }
    }
  }
  return {}
}

/**
 * Resolve one DOI through Crossref.
 * @param {string} doi
 * @param {AbortSignal} [signal]
 */
export async function fetchCrossrefByDoi(doi, signal) {
  const params = new URLSearchParams()
  if (process.env.CROSSREF_EMAIL) params.set('mailto', process.env.CROSSREF_EMAIL)
  const suffix = params.size > 0 ? `?${params}` : ''
  const payload = await requestJson(
    `https://api.crossref.org/works/${encodeURIComponent(doi)}${suffix}`,
    { signal },
  )
  const message = payload?.message
  if (!message) throw new Error(`Crossref returned no record for DOI ${doi}`)

  const authors = Array.isArray(message.author)
    ? message.author
        .map((author) => [author.given, author.family].filter(Boolean).join(' ') || author.name)
        .filter(Boolean)
    : []
  const { year, date } = dateParts(message)
  const journal = first(
    message['container-title']?.[0],
    message['short-container-title']?.[0],
    message.publisher,
  )
  const pdfUrl = Array.isArray(message.link)
    ? message.link.find((link) => String(link?.['content-type'] ?? '').includes('pdf'))?.URL
    : undefined
  const abstract = cleanText(message.abstract)

  return {
    source: 'crossref',
    id: message.DOI ?? doi,
    title: cleanText(first(message.title?.[0], message['short-title']?.[0], '') ?? ''),
    ...(authors.length > 0 ? { authors } : {}),
    ...(journal ? { journal } : {}),
    ...(Number.isFinite(year) ? { year: toYear(year) ?? year } : {}),
    ...(date ? { date } : {}),
    ...(message.volume ? { volume: String(message.volume) } : {}),
    ...(message.issue ? { issue: String(message.issue) } : {}),
    ...(message.page ? { pages: String(message.page) } : {}),
    doi: message.DOI ?? doi,
    ...(abstract ? { abstract } : {}),
    url: message.URL ?? `https://doi.org/${doi}`,
    ...(pdfUrl ? { pdf_url: pdfUrl } : {}),
    type: message.type === 'posted-content' ? 'preprint' : message.type === 'journal-article' ? 'article' : String(message.type ?? 'article'),
  }
}
