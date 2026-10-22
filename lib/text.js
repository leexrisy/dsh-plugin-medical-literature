/** Text cleanup shared by every source adapter. */

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
}

/** Decode the XML/HTML entities scholarly APIs actually emit. */
export function decodeEntities(value) {
  return String(value ?? '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const numeric = code[1]?.toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10)
      if (!Number.isFinite(numeric)) return match
      try {
        return String.fromCodePoint(numeric)
      } catch {
        return match
      }
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match
  })
}

/** Remove markup while keeping the words apart. */
export function stripTags(value) {
  return String(value ?? '').replace(/<[^>]*>/g, ' ')
}

/** Collapse markup, entities, and whitespace into one readable line. */
export function cleanText(value) {
  return decodeEntities(stripTags(value)).replace(/\s+/g, ' ').trim()
}

/** Truncate at a word boundary, appending an ellipsis. */
export function truncate(value, limit) {
  const text = String(value ?? '')
  if (!limit || limit <= 0 || text.length <= limit) return text
  const cut = text.slice(0, limit)
  const boundary = cut.lastIndexOf(' ')
  const body = boundary > limit * 0.6 ? cut.slice(0, boundary) : cut
  return `${body.trimEnd()}…`
}

/** First defined, non-empty value. */
export function first(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue
    if (typeof value === 'string' && value.trim() === '') continue
    if (Array.isArray(value) && value.length === 0) continue
    return value
  }
  return undefined
}

/** Coerce a publication year string to an integer, or undefined. */
export function toYear(value) {
  const match = /(?:^|\D)((?:1[5-9]|20)\d{2})(?:\D|$)/.exec(String(value ?? ''))
  return match ? Number.parseInt(match[1], 10) : undefined
}

/** Normalise `PMC123`, `123`, `PMC1234567` to `PMC1234567`. */
export function normalizePmcid(value) {
  if (!value) return undefined
  const match = /(?:PMC)?\s*(\d{3,9})/i.exec(String(value))
  return match ? `PMC${match[1]}` : undefined
}
