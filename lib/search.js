/**
 * Multi-source search orchestration: run the requested sources in parallel,
 * isolate per-source failures, fuse ranked lists, and merge duplicates.
 *
 * Each source is treated as a ranked list produced by its own engine (PubMed
 * Best Match, Europe PMC relevance, arXiv relevance). The default fusion is
 * reciprocal rank fusion (RRF), which uses only those ranks and never replaces
 * the engine's relevance judgement with a local term-frequency score. `bm25`
 * is available only when a caller explicitly asks for local re-ranking.
 */

import { searchArxiv } from './sources/arxiv.js'
import { searchEuropePmc } from './sources/europepmc.js'
import { searchPubMed } from './sources/pubmed.js'
import { dedupeRecords, mergeRecord, recordKeys } from './normalize.js'

/** Source identifiers accepted by the tools. */
export const SOURCE_NAMES = ['pubmed', 'europepmc', 'arxiv', 'biorxiv', 'medrxiv']

/** Sources searched when the caller does not choose. */
export const DEFAULT_SOURCES = ['pubmed', 'europepmc', 'arxiv', 'biorxiv']

/** Supported fusion strategies. */
export const FUSIONS = ['rrf', 'source', 'bm25']

/** RRF's rank constant: higher dampens the advantage of top ranks. */
const RRF_K = 60

const RANK_STOPWORDS = new Set(
  `a an and are as at be been by for from had has have how if in into is it its more most not of on or our
   shall should such than that the their them then there these they this those to was we were what when where
   which while who will with would you your`
    .split(/\s+/)
    .filter(Boolean),
)

function runSource(source, options) {
  switch (source) {
    case 'pubmed':
      return searchPubMed(options)
    case 'arxiv':
      return searchArxiv(options)
    case 'europepmc':
      return searchEuropePmc(options)
    case 'biorxiv':
      return searchEuropePmc({ ...options, preprint: 'biorxiv' })
    case 'medrxiv':
      return searchEuropePmc({ ...options, preprint: 'medrxiv' })
    default:
      return Promise.reject(new Error(`Unknown source "${source}"`))
  }
}

/** Keep only fields the output schema declares, dropping empties and fixing required ones. */
function project(record) {
  const output = {}
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value) && value.length === 0) continue
    output[key] = value
  }
  output.source ||= 'unknown'
  output.id ||= output.doi ?? output.pmid ?? output.arxiv_id ?? output.pmcid ?? 'unknown'
  output.title ||= '(untitled)'
  output.url ||= output.doi ? `https://doi.org/${output.doi}` : ''
  return output
}

/**
 * Reciprocal rank fusion over each source's native order.
 * A record's score is the sum of `1 / (K + rank)` across the sources that
 * returned it; duplicates merge their metadata but never alter source ranks.
 */
function fuseByRrf(perSource) {
  const buckets = new Map()

  for (const { records } of perSource) {
    records.forEach((record, index) => {
      const keys = recordKeys(record)
      let bucket
      for (const key of keys) {
        if (buckets.has(key)) {
          bucket = buckets.get(key)
          break
        }
      }

      if (bucket === undefined) {
        bucket = { record: { ...record }, score: 0, bestRank: index + 1 }
        for (const key of keys) buckets.set(key, bucket)
      } else {
        mergeRecord(bucket.record, record)
        for (const key of keys) if (!buckets.has(key)) buckets.set(key, bucket)
      }

      bucket.score += 1 / (RRF_K + index + 1)
      bucket.bestRank = Math.min(bucket.bestRank, index + 1)
    })
  }

  return [...new Set(buckets.values())]
    .sort((left, right) => right.score - left.score || left.bestRank - right.bestRank)
    .map((bucket) => bucket.record)
}

/** Token list for the optional local BM25 fusion. */
function rankTokens(text) {
  return (String(text ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (token) => token.length >= 3 && !RANK_STOPWORDS.has(token),
  )
}

/**
 * Optional local re-ranking, used only when the caller asks for `bm25`.
 * It scores title + abstract against the query; it does not know MeSH,
 * citation counts, or recency, so it must not be the default.
 */
function bm25Rerank(records, query) {
  const terms = [...new Set(rankTokens(query))]
  if (terms.length === 0 || records.length === 0) return records

  const docs = records.map((record) => rankTokens(`${record.title ?? ''} ${record.abstract ?? ''}`))
  const averageLength = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length
  const documentFrequency = new Map()
  for (const term of terms) {
    documentFrequency.set(term, docs.filter((doc) => doc.includes(term)).length)
  }

  const total = docs.length
  const k1 = 1.5
  const b = 0.75
  return records
    .map((record, index) => {
      const doc = docs[index]
      const frequency = new Map()
      for (const token of doc) frequency.set(token, (frequency.get(token) ?? 0) + 1)
      let score = 0
      for (const term of terms) {
        const tf = frequency.get(term) ?? 0
        if (tf === 0) continue
        const df = documentFrequency.get(term) ?? 0
        const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5))
        score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (doc.length / Math.max(1, averageLength)))))
      }
      return { record, score }
    })
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.record)
}

/**
 * Search several sources and fuse their ranked lists.
 *
 * `maxResults` is the per-source recall window. `finalMaxResults` is the
 * overall result cap after fusion. A failing source never hides the others:
 * its message is reported in `errors`. The call only rejects when every
 * requested source failed.
 *
 * @param {object} options
 * @param {string} [options.query] shared query for sources without an override
 * @param {Record<string, string>} [options.queries] per-source queries
 * @param {string[]} [options.sources] sources to search when `queries` is omitted
 * @param {number} options.maxResults per-source recall window
 * @param {number} [options.finalMaxResults] overall cap after fusion
 * @param {'rrf'|'source'|'bm25'} [options.fusion] default `rrf`
 * @param {number} [options.yearFrom]
 * @param {number} [options.yearTo]
 * @param {'relevance'|'date'|'cited'} [options.sort]
 * @param {AbortSignal} [options.signal]
 */
export async function searchAll({
  query,
  queries,
  sources,
  maxResults,
  finalMaxResults,
  fusion = 'rrf',
  yearFrom,
  yearTo,
  sort = 'relevance',
  signal,
}) {
  const bySource =
    queries ?? Object.fromEntries((sources ?? DEFAULT_SOURCES).map((source) => [source, query]))
  const selected = Object.keys(bySource)

  const perSource = await Promise.all(
    selected.map(async (source) => {
      try {
        const outcome = await runSource(source, {
          query: bySource[source],
          maxResults,
          yearFrom,
          yearTo,
          sort,
          signal,
        })
        return {
          source,
          records: (outcome.records ?? []).map(project),
          total: outcome.total ?? 0,
        }
      } catch (error) {
        return {
          source,
          records: [],
          total: 0,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }),
  )

  const errors = perSource
    .filter((result) => result.error)
    .map((result) => ({ source: result.source, message: result.error }))

  const raw = perSource.flatMap((result) => result.records)
  if (raw.length === 0 && errors.length === selected.length) {
    throw new Error(
      `All literature sources failed:\n${errors.map((entry) => `- ${entry.source}: ${entry.message}`).join('\n')}`,
    )
  }

  // A date or citation sort is a single global order; fusion would fight it.
  const effectiveFusion = sort === 'date' || sort === 'cited' ? 'source' : fusion
  const limit = Number.isInteger(finalMaxResults) && finalMaxResults > 0 ? finalMaxResults : raw.length

  let records
  let removed
  if (effectiveFusion === 'rrf') {
    records = fuseByRrf(perSource)
    removed = raw.length - records.length
  } else {
    const deduped = dedupeRecords(raw)
    removed = deduped.removed
    records =
      effectiveFusion === 'bm25'
        ? bm25Rerank(deduped.records, query ?? Object.values(bySource).join(' '))
        : deduped.records
  }

  if (sort === 'date') {
    records.sort((left, right) => String(right.date ?? '').localeCompare(String(left.date ?? '')))
  }

  const finalRecords = records.slice(0, limit)
  const counts = Object.fromEntries(selected.map((source) => [source, 0]))
  for (const record of finalRecords) counts[record.source] = (counts[record.source] ?? 0) + 1

  return {
    records: finalRecords,
    counts,
    totals: Object.fromEntries(perSource.map((result) => [result.source, result.total])),
    removedDuplicates: removed,
    errors,
    fusion: effectiveFusion,
  }
}
