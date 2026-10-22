/**
 * Single-record resolution: DOI, PMID, PMCID, arXiv id, or a pasted URL.
 */

import { fetchArxivById } from './sources/arxiv.js'
import { fetchCrossrefByDoi } from './sources/crossref.js'
import { searchEuropePmc } from './sources/europepmc.js'
import { fetchPubMedRecords } from './sources/pubmed.js'
import { normalizeArxivId, normalizeDoi } from './normalize.js'
import { normalizePmcid } from './text.js'
import { requestJson } from './http.js'

/**
 * Classify a user-supplied identifier.
 * @param {string} raw
 * @returns {{kind: 'doi'|'pmid'|'pmcid'|'arxiv'|'query', value: string}}
 */
export function parseIdentifier(raw) {
  const value = String(raw ?? '').trim()

  const doiUrl = /^https?:\/\/(?:dx\.)?doi\.org\/(10\.\d{4,9}\/\S+)$/i.exec(value)
  if (doiUrl) return { kind: 'doi', value: normalizeDoi(doiUrl[1]) ?? doiUrl[1] }

  const pubmedUrl = /^https?:\/\/(?:pubmed\.ncbi\.nlm\.nih\.gov|www\.ncbi\.nlm\.nih\.gov\/pubmed)\/(\d+)/i.exec(value)
  if (pubmedUrl) return { kind: 'pmid', value: pubmedUrl[1] }

  const pmcUrl = /^https?:\/\/(?:pmc\.ncbi\.nlm\.nih\.gov|www\.ncbi\.nlm\.nih\.gov\/pmc)\/articles\/(PMC\d+)/i.exec(value)
  if (pmcUrl) return { kind: 'pmcid', value: pmcUrl[1].toUpperCase() }

  const arxivUrl = /^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/([^?#]+?)(?:\.pdf)?$/i.exec(value)
  if (arxivUrl) {
    const id = normalizeArxivId(arxivUrl[1])
    if (id) return { kind: 'arxiv', value: id }
  }

  const explicitDoi = /^(?:doi[:\s]+)?(10\.\d{4,9}\/\S+)$/i.exec(value)
  if (explicitDoi) return { kind: 'doi', value: normalizeDoi(explicitDoi[1]) ?? explicitDoi[1] }

  const explicitArxiv = /^arxiv[:\s]+(\S+)$/i.exec(value)
  if (explicitArxiv) {
    const id = normalizeArxivId(explicitArxiv[1])
    if (id) return { kind: 'arxiv', value: id }
  }

  const explicitPmid = /^pmid[:\s]*(\d+)$/i.exec(value)
  if (explicitPmid) return { kind: 'pmid', value: explicitPmid[1] }

  const explicitPmcid = /^(?:pmcid[:\s]*)?(PMC\d+)$/i.exec(value)
  if (explicitPmcid) return { kind: 'pmcid', value: explicitPmcid[1].toUpperCase() }

  if (/^\d{1,9}$/.test(value)) return { kind: 'pmid', value }
  if (/^PMC\d+$/i.test(value)) return { kind: 'pmcid', value: value.toUpperCase() }

  const bareArxiv = normalizeArxivId(value)
  if (bareArxiv && /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})$/i.test(value)) {
    return { kind: 'arxiv', value: bareArxiv }
  }

  return { kind: 'query', value }
}

/**
 * Resolve a PMCID that Europe PMC has not indexed yet.
 * NCBI's ID converter maps it to a PMID/DOI; the record then comes from PubMed
 * or Crossref. This covers the indexing lag for very recent PMC articles.
 */
async function resolvePmcidViaNcbi(pmcid, signal) {
  const url =
    'https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?' +
    `ids=${encodeURIComponent(pmcid)}&format=json&tool=dsh-medical-literature`
  const data = await requestJson(url, { signal, timeoutMs: 15_000 })
  const converted = data?.records?.[0]
  if (!converted) return undefined

  if (converted.pmid) {
    const records = await fetchPubMedRecords([String(converted.pmid)], signal)
    if (records[0]) return records[0]
  }
  if (converted.doi) {
    try {
      return await fetchCrossrefByDoi(converted.doi, signal)
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Resolve one identifier into a record.
 *
 * @param {object} options
 * @param {string} options.identifier
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{found: boolean, record?: object, message?: string}>}
 */
export async function getByIdentifier({ identifier, signal }) {
  const parsed = parseIdentifier(identifier)
  const attempts = []

  if (parsed.kind === 'pmid') {
    const records = await fetchPubMedRecords([parsed.value], signal)
    const record = records[0]
    if (record) return { found: true, record }
    attempts.push(`PubMed PMID ${parsed.value}`)
    const fallback = await searchEuropePmc({
      query: `EXT_ID:${parsed.value} AND SRC:MED`,
      maxResults: 1,
      signal,
    })
    if (fallback.records[0]) return { found: true, record: fallback.records[0] }
    attempts.push('Europe PMC')
  }

  if (parsed.kind === 'pmcid') {
    const pmcid = normalizePmcid(parsed.value) ?? parsed.value
    const { records } = await searchEuropePmc({
      query: `PMCID:"${pmcid}"`,
      maxResults: 1,
      signal,
    })
    if (records[0]) return { found: true, record: records[0] }
    attempts.push(`Europe PMC ${pmcid}`)
    try {
      const converted = await resolvePmcidViaNcbi(pmcid, signal)
      if (converted) return { found: true, record: converted }
      attempts.push('NCBI PMC ID converter')
    } catch (error) {
      attempts.push(`NCBI PMC ID converter (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  if (parsed.kind === 'arxiv') {
    const record = await fetchArxivById(parsed.value, signal)
    if (record) return { found: true, record }
    attempts.push(`arXiv ${parsed.value}`)
  }

  if (parsed.kind === 'doi') {
    const doi = normalizeDoi(parsed.value) ?? parsed.value
    const { records } = await searchEuropePmc({
      query: `DOI:"${doi}"`,
      maxResults: 1,
      signal,
    })
    if (records[0]) return { found: true, record: records[0] }
    attempts.push('Europe PMC')
    try {
      const crossref = await fetchCrossrefByDoi(doi, signal)
      if (crossref?.title) return { found: true, record: crossref }
    } catch (error) {
      attempts.push(`Crossref (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  if (parsed.kind === 'query') {
    const { records } = await searchEuropePmc({
      query: parsed.value,
      maxResults: 1,
      signal,
    })
    if (records[0]) return { found: true, record: records[0] }
    attempts.push('Europe PMC free-text search')
  }

  return {
    found: false,
    message: `No record found for "${identifier}" (${parsed.kind}: ${parsed.value}). Tried: ${
      attempts.length > 0 ? attempts.join(', ') : 'the matching source'
    }.`,
  }
}
