/**
 * Evidence check: locate the passages most likely to support a claim, and
 * audit a small reference list for duplicates and retractions.
 *
 * This is lexical retrieval (BM25 + query-term coverage), not semantic
 * entailment. It narrows a paper down to a few candidate passages; the model
 * and the human still decide whether the passage actually supports the claim.
 */

import { fetchFulltextForRecord } from './fulltext.js'
import { getByIdentifier } from './get.js'
import { normalizeDoi, titleKey } from './normalize.js'

const STOPWORDS = new Set(
  `a an and are as at be been being by can could did do does for from had has have how if in into is it its
   may might more most must not of on or our shall should such than that the their them then there these they
   this those to was we were what when where which while who will with would you your`
    .split(/\s+/)
    .filter(Boolean),
)

const MAX_PASSAGE_CHARS = 1400
const MAX_PASSAGES = 500

/** Negation cues BM25 cannot see; used only to raise a manual-review warning. */
const NEGATION = /\b(?:not|no|never|without|none|cannot|can't|doesn't|didn't|isn't|aren't|fail(?:s|ed)?|absence)\b/i

/** Lowercase, strip a trailing plural `s`, and keep alphanumerics. */
function normalizeToken(token) {
  let value = token.toLowerCase()
  if (value.length > 4 && value.endsWith('s') && !value.endsWith('ss')) value = value.slice(0, -1)
  return value
}

/** Token list used for both passages and the claim. */
export function tokenize(text) {
  const tokens = String(text ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []
  return tokens.map(normalizeToken)
}

/** Distinct claim terms after stopword and length filtering. */
export function claimTerms(claim) {
  const terms = []
  for (const token of tokenize(claim)) {
    if (token.length < 3 || STOPWORDS.has(token)) continue
    if (!terms.includes(token)) terms.push(token)
  }
  return terms
}

/** Split long text on sentence boundaries into bounded chunks. */
export function chunkText(text, maxChars = MAX_PASSAGE_CHARS) {
  const value = String(text ?? '').trim()
  if (value.length <= maxChars) return value ? [value] : []
  const sentences = value.match(/[^.!?]+[.!?]+|\S+/g) ?? [value]
  const chunks = []
  let current = ''
  for (const sentence of sentences) {
    if (current.length + sentence.length + 1 > maxChars && current) {
      chunks.push(current.trim())
      current = sentence
    } else {
      current += `${current ? ' ' : ''}${sentence}`
    }
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks
}

/**
 * Split a paragraph into sentences, re-joining fragments that end in a known
 * abbreviation or are too short to stand alone.
 */
const ABBREVIATION = /\b(?:e\.g|i\.e|et al|vs|Fig|No|Dr|Prof|approx|ca)\.$/i

export function splitSentences(text) {
  const raw = String(text ?? '').split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/)
  const sentences = []
  for (const piece of raw) {
    const trimmed = piece.trim()
    if (!trimmed) continue
    const previous = sentences[sentences.length - 1]
    if (previous && (previous.length < 60 || ABBREVIATION.test(previous))) {
      sentences[sentences.length - 1] = `${previous} ${trimmed}`
    } else {
      sentences.push(trimmed)
    }
  }
  return sentences
}

/**
 * Flatten full-text sections into sentence-level passages. Sentence-level
 * retrieval is more precise for claim checking than long paragraphs, whose
 * repeated terms can dominate a BM25 score.
 */
export function passagesFromSections(sections) {
  const passages = []
  for (const section of sections) {
    for (const paragraph of String(section.text ?? '').split(/\n{2,}/)) {
      for (const sentence of splitSentences(paragraph)) {
        for (const chunk of chunkText(sentence)) {
          if (chunk.length < 40) continue
          passages.push({ section: section.title || 'Body', text: chunk })
          if (passages.length >= MAX_PASSAGES) return passages
        }
      }
    }
  }
  return passages
}

/**
 * Rank passages against claim terms with BM25 and report term coverage.
 * Coverage is the interpretable signal: `0.5` means half the distinct claim
 * terms occur in that passage.
 *
 * @param {{section: string, text: string}[]} passages
 * @param {string[]} terms
 * @returns {Array<{section: string, text: string, score: number, coverage: number}>}
 */
export function scorePassages(passages, terms) {
  if (passages.length === 0 || terms.length === 0) return []
  const docs = passages.map((passage) => tokenize(passage.text))
  const totalLength = docs.reduce((sum, doc) => sum + doc.length, 0)
  const averageLength = totalLength / Math.max(1, docs.length)
  const documentFrequency = new Map()
  for (const term of terms) {
    let count = 0
    for (const doc of docs) if (doc.includes(term)) count += 1
    documentFrequency.set(term, count)
  }

  const k1 = 1.5
  const b = 0.75
  const total = docs.length
  return passages
    .map((passage, index) => {
      const doc = docs[index]
      const length = doc.length || 1
      const frequency = new Map()
      for (const token of doc) frequency.set(token, (frequency.get(token) ?? 0) + 1)

      let score = 0
      let matched = 0
      for (const term of terms) {
        const tf = frequency.get(term) ?? 0
        if (tf > 0) matched += 1
        const df = documentFrequency.get(term) ?? 0
        const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5))
        score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (length / averageLength))))
      }

      return {
        ...passage,
        score: Number(score.toFixed(2)),
        coverage: Number((matched / terms.length).toFixed(2)),
      }
    })
    .sort((left, right) => right.score - left.score)
}

/** Group identifiers that resolve to the same DOI or normalized title. */
export function findDuplicates(entries) {
  const groups = new Map()
  for (const entry of entries) {
    if (!entry.found || !entry.record) continue
    const keys = []
    const doi = normalizeDoi(entry.record.doi)
    if (doi) keys.push(`doi:${doi}`)
    const title = titleKey(entry.record.title)
    if (title) keys.push(`title:${title}`)
    for (const key of keys) {
      const list = groups.get(key) ?? []
      list.push(entry.identifier)
      groups.set(key, list)
    }
  }

  const seen = new Set()
  const duplicates = []
  for (const [key, identifiers] of groups) {
    if (identifiers.length < 2) continue
    const signature = [...identifiers].sort().join('|')
    if (seen.has(signature)) continue
    seen.add(signature)
    duplicates.push({
      kind: key.startsWith('doi:') ? 'doi' : 'title',
      value: key.slice(key.indexOf(':') + 1),
      identifiers: [...identifiers],
    })
  }
  return duplicates
}

/**
 * Resolve identifiers, optionally rank supporting passages, and audit the set.
 *
 * @param {object} options
 * @param {string} [options.claim]
 * @param {string[]} options.identifiers
 * @param {number} [options.topK]
 * @param {boolean} [options.deep] fetch open-access full text when available
 * @param {AbortSignal} [options.signal]
 */
export async function runCheck({ claim, identifiers, topK = 3, deep = true, signal }) {
  const terms = claim ? claimTerms(claim) : []
  const claimNegated = claim ? NEGATION.test(claim) : false
  const entries = []
  const warnings = []

  for (const identifier of identifiers) {
    const resolved = await getByIdentifier({ identifier, signal })
    entries.push({ identifier, ...resolved })
  }

  const items = []
  for (const entry of entries) {
    if (!entry.found || !entry.record) {
      items.push({ identifier: entry.identifier, found: false, message: entry.message ?? 'No record found.' })
      continue
    }

    const record = entry.record
    const item = {
      identifier: entry.identifier,
      found: true,
      id: record.pmcid ?? record.pmid ?? record.arxiv_id ?? record.doi ?? record.id,
      title: record.title,
      ...(record.year ? { year: record.year } : {}),
      ...(record.journal ? { journal: record.journal } : {}),
      ...(record.doi ? { doi: record.doi } : {}),
      ...(record.pmid ? { pmid: record.pmid } : {}),
      ...(record.pmcid ? { pmcid: record.pmcid } : {}),
      ...(record.arxiv_id ? { arxiv_id: record.arxiv_id } : {}),
      retracted: record.retracted === true,
    }

    if (record.retracted) warnings.push(`Retracted source: ${entry.identifier}`)

    if (claim) {
      const full = deep ? await fetchFulltextForRecord(record, signal) : { found: false }
      let passages = []
      let evidenceSource = 'none'

      if (full.found) {
        passages = passagesFromSections(full.sections)
        evidenceSource = full.source
      }
      if (passages.length === 0 && record.abstract) {
        // Sentence-level even for the abstract: one long paragraph would match
        // almost every claim term and hide which sentence actually supports it.
        passages = passagesFromSections([{ title: 'Abstract', text: record.abstract }])
        evidenceSource = 'abstract'
      }

      item.evidence_source = evidenceSource
      const ranked = scorePassages(passages, terms).slice(0, topK)
      item.passages = ranked

      if (ranked.length === 0) {
        warnings.push(`No passage to check for ${entry.identifier}; read the source directly.`)
      } else if (ranked[0].coverage < 0.25) {
        warnings.push(
          `Very weak lexical match for ${entry.identifier} (top coverage ${ranked[0].coverage}); the source probably does not support this claim.`,
        )
      } else if (ranked[0].coverage < 0.5) {
        warnings.push(
          `Partial lexical match for ${entry.identifier} (top coverage ${ranked[0].coverage}); read the passages before relying on them.`,
        )
      }

      // Negation is invisible to BM25, so flag a polarity mismatch explicitly.
      if (ranked.length > 0 && claimNegated !== NEGATION.test(ranked[0].text)) {
        warnings.push(
          `Polarity differs between the claim and the top passage for ${entry.identifier}; check negation manually.`,
        )
      }
    }

    items.push(item)
  }

  return {
    ...(claim ? { claim } : {}),
    checked: identifiers.length,
    items,
    duplicates: findDuplicates(entries),
    warnings,
  }
}
