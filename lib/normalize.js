/** Cross-source record normalisation and duplicate merging. */

/** Lowercase DOI without a resolver prefix or trailing punctuation. */
export function normalizeDoi(value) {
  if (!value) return undefined
  const doi = String(value)
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .replace(/[.,;\s]+$/, '')
  return /^10\.\d{4,9}\/\S+$/i.test(doi) ? doi.toLowerCase() : undefined
}

/** Base arXiv identifier without a version suffix or URL wrapper. */
export function normalizeArxivId(value) {
  if (!value) return undefined
  const match = /((?:\d{4}\.\d{4,5})|(?:[a-z-]+(?:\.[a-z]{2})?\/\d{7}))(?:v\d+)?/i.exec(String(value))
  return match ? match[1] : undefined
}

/** Comparison key for a title: letters and digits only, lowercased. */
export function titleKey(value) {
  const key = String(value ?? '')
    .toLowerCase()
    .replace(/<[^>]*>/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  return key.length >= 20 ? key : undefined
}

/** Stable keys for duplicate detection, derived from every available identifier. */
export function recordKeys(record) {
  const keys = []
  if (record.doi) keys.push(`doi:${normalizeDoi(record.doi) ?? record.doi.toLowerCase()}`)
  if (record.pmid) keys.push(`pmid:${record.pmid}`)
  if (record.arxiv_id) keys.push(`arxiv:${normalizeArxivId(record.arxiv_id) ?? record.arxiv_id}`)
  if (record.pmcid) keys.push(`pmcid:${record.pmcid.toUpperCase()}`)
  const title = titleKey(record.title)
  if (title) keys.push(`title:${title}`)
  return keys
}

/** Fields a duplicate may contribute when the surviving record lacks them. */
const MERGEABLE_FIELDS = [
  'authors',
  'journal',
  'year',
  'date',
  'doi',
  'pmid',
  'arxiv_id',
  'pmcid',
  'volume',
  'issue',
  'pages',
  'abstract',
  'pdf_url',
  'type',
]

function isEmpty(value) {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  )
}

/** Fill a surviving record's gaps from a duplicate; a retraction marker wins. */
export function mergeRecord(existing, record) {
  for (const field of MERGEABLE_FIELDS) {
    if (isEmpty(existing[field]) && !isEmpty(record[field])) existing[field] = record[field]
  }
  if (record.retracted === true) existing.retracted = true
  return existing
}

/**
 * Merge records that describe the same work.
 *
 * Records are kept in their original order (source order, then relevance), so
 * a PubMed hit keeps its own id while gaining the open-access PDF link that a
 * Europe PMC duplicate supplied. Any DOI, PMID, arXiv id, PMCID, or long title
 * match counts as the same work.
 *
 * @param {Array<object>} records
 * @returns {{records: Array<object>, removed: number}}
 */
export function dedupeRecords(records) {
  const unique = []
  const indexByKey = new Map()

  for (const record of records) {
    const keys = recordKeys(record)
    let target
    for (const key of keys) {
      const hit = indexByKey.get(key)
      if (hit !== undefined) {
        target = hit
        break
      }
    }

    if (target === undefined) {
      target = unique.length
      unique.push({ ...record })
    } else {
      mergeRecord(unique[target], record)
    }

    for (const key of keys) {
      if (!indexByKey.has(key)) indexByKey.set(key, target)
    }
  }

  return { records: unique, removed: records.length - unique.length }
}
