/**
 * Citation formatting for medical records: BibTeX, RIS, CSL-JSON, and the
 * Vancouver, APA 7, GB/T 7714-2015, and Nature text templates.
 *
 * The formatters are deterministic and offline: they only use the metadata the
 * search adapters already returned (authors, journal, year, volume, issue,
 * pages, DOI, arXiv id). Templates are standard approximations, not
 * journal-endorsed output.
 */

/** Bare record title without a trailing period. */
function cleanTitle(record) {
  return String(record.title ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/, '')
    .trim()
}

function isPreprint(record) {
  return record.type === 'preprint' || (!record.journal && Boolean(record.arxiv_id))
}

/** Journal or preprint server label. */
function venueOf(record) {
  if (record.journal) return String(record.journal)
  if (!isPreprint(record)) return ''
  const doi = String(record.doi ?? '').toLowerCase()
  if (record.source === 'medrxiv') return 'medRxiv'
  if (record.source === 'biorxiv') return 'bioRxiv'
  if (doi.startsWith('10.1101/')) return 'bioRxiv'
  if (record.arxiv_id) return 'arXiv'
  return 'Preprint'
}

/**
 * Split an author string into family and given parts.
 * Handles `Laurent M` (PubMed), `Ashish Vaswani` (arXiv), `Last, First`, and
 * multi-word families such as `van der Walt SJ`.
 *
 * @param {string} raw
 * @returns {{family: string, given: string}}
 */
export function parseName(raw) {
  const value = String(raw ?? '').trim().replace(/\.+$/, '')
  if (!value) return { family: '', given: '' }

  if (value.includes(',')) {
    const [family, ...rest] = value.split(',')
    return { family: family.trim(), given: rest.join(',').trim() }
  }

  const parts = value.split(/\s+/).filter(Boolean)
  if (parts.length === 1) return { family: value, given: '' }

  const last = parts[parts.length - 1]
  // PubMed stores initials compactly: "Laurent M", "van der Walt SJ".
  if (/^[A-Z]{1,4}$/.test(last)) {
    return { family: parts.slice(0, -1).join(' '), given: last }
  }
  // arXiv/Crossref store "Given Family".
  return { family: last, given: parts.slice(0, -1).join(' ') }
}

/** Compact initials for Vancouver/GB/T: `SJ`, `A`, `AN`, `J-P`. */
function compactInitials(given) {
  const value = String(given ?? '').trim()
  if (!value) return ''
  const parts = value.split(/\s+/).filter(Boolean)
  if (parts.length === 1 && /^[A-Z]{1,4}$/.test(parts[0])) return parts[0]
  return parts
    .map((part) =>
      part
        .split('-')
        .map((piece) => (piece ? piece[0].toUpperCase() : ''))
        .join('-'),
    )
    .join('')
}

/** Period-separated initials for APA/Nature: `S. J.`, `M.`, `J.-P.`. */
function periodInitials(given) {
  const value = String(given ?? '').trim()
  if (!value) return ''
  const parts = value.split(/\s+/).filter(Boolean)
  if (parts.length === 1 && /^[A-Z]{1,4}$/.test(parts[0])) {
    return parts[0].split('').map((letter) => `${letter}.`).join(' ')
  }
  return parts
    .map((part) =>
      part
        .split('-')
        .map((piece) => (piece ? `${piece[0].toUpperCase()}.` : ''))
        .join('-'),
    )
    .join(' ')
}

/** Remove trailing periods so a template never emits `et al..`. */
function trimPeriod(value) {
  return String(value ?? '').replace(/\.+$/, '')
}

function authorsOf(record) {
  return Array.isArray(record.authors) ? record.authors.filter(Boolean) : []
}

/** `Laurent M` form used by Vancouver and GB/T. */
function shortName(raw) {
  const { family, given } = parseName(raw)
  return [family, compactInitials(given)].filter(Boolean).join(' ')
}

function vancouverAuthors(authors) {
  const names = authors.slice(0, 6).map(shortName)
  return authors.length > 6 ? `${names.join(', ')}, et al.` : names.join(', ')
}

function gbAuthors(authors) {
  const names = authors.slice(0, 3).map((raw) => {
    const { family, given } = parseName(raw)
    return [family.toUpperCase(), compactInitials(given)].filter(Boolean).join(' ')
  })
  return authors.length > 3 ? `${names.join(', ')}, et al.` : names.join(', ')
}

function apaAuthors(authors) {
  const names = authors.map((raw) => {
    const { family, given } = parseName(raw)
    const short = periodInitials(given)
    return short ? `${family}, ${short}` : family
  })
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]
  if (names.length <= 20) return `${names.slice(0, -1).join(', ')}, & ${names[names.length - 1]}`
  return `${names.slice(0, 19).join(', ')}, … ${names[names.length - 1]}`
}

function natureAuthors(authors) {
  const names = authors.map((raw) => {
    const { family, given } = parseName(raw)
    const short = periodInitials(given)
    return short ? `${family}, ${short}` : family
  })
  if (names.length === 0) return ''
  if (names.length > 5) return `${names[0]} et al.`
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`
}

function yearOf(record) {
  return Number.isFinite(record.year) ? String(record.year) : ''
}

function doiSuffix(record) {
  return record.doi ? ` doi:${record.doi}` : ''
}

/** Vancouver: Authors. Title. Journal. Year;Volume(Issue):Pages. doi:... */
export function vancouver(record) {
  const authors = vancouverAuthors(authorsOf(record))
  const title = cleanTitle(record)
  const year = yearOf(record)
  const venue = venueOf(record)
  const locator = [
    year ? `${year}${record.volume ? `;${record.volume}` : ''}${record.issue ? `(${record.issue})` : ''}${record.pages ? `:${record.pages}` : ''}` : '',
  ]
    .filter(Boolean)
    .join('')

  if (isPreprint(record)) {
    const venue = venueOf(record)
    const link = record.arxiv_id
      ? `https://arxiv.org/abs/${String(record.arxiv_id).replace(/v\d+$/, '')}`
      : record.url ?? (record.doi ? `https://doi.org/${record.doi}` : '')
    return `${trimPeriod(authors)}. ${title} [Preprint]. ${venue}.${year ? ` ${year}.` : ''}${link ? ` ${link}` : ''}${doiSuffix(record)}`
      .replace(/\s+/g, ' ')
      .trim()
  }
  return `${trimPeriod(authors)}. ${title}. ${venue}. ${locator}.${doiSuffix(record)}`.replace(/\s+/g, ' ').trim()
}

/** APA 7: Authors (Year). Title. Journal, Volume(Issue), Pages. https://doi.org/... */
export function apa(record) {
  const authors = apaAuthors(authorsOf(record))
  const year = yearOf(record) || 'n.d.'
  const title = cleanTitle(record)
  const venue = venueOf(record)
  const locator = `${record.volume ? `, ${record.volume}` : ''}${record.issue ? `(${record.issue})` : ''}${record.pages ? `, ${record.pages}` : ''}`
  const link = record.doi ? ` https://doi.org/${record.doi}` : record.url ? ` ${record.url}` : ''

  if (isPreprint(record)) {
    const preprintLink = record.arxiv_id
      ? `https://arxiv.org/abs/${String(record.arxiv_id).replace(/v\d+$/, '')}`
      : record.url ?? (record.doi ? `https://doi.org/${record.doi}` : '')
    return `${authors} (${year}). ${title} [Preprint]. ${venue}.${preprintLink ? ` ${preprintLink}` : ''}`
      .replace(/\s+/g, ' ')
      .trim()
  }
  return `${authors} (${year}). ${title}. ${venue}${locator}.${link}`.replace(/\s+/g, ' ').trim()
}

/** GB/T 7714-2015: Authors. Title[J]. Journal, Year, Volume(Issue): Pages. DOI. */
export function gbT7714(record) {
  const authors = gbAuthors(authorsOf(record))
  const title = cleanTitle(record)
  const year = yearOf(record)
  const venue = venueOf(record)
  const locator = `${year ? `, ${year}` : ''}${record.volume ? `, ${record.volume}` : ''}${record.issue ? `(${record.issue})` : ''}${record.pages ? `: ${record.pages}` : ''}`
  const doi = record.doi ? ` DOI:${record.doi}.` : ''

  if (isPreprint(record)) {
    const preprintLink = record.arxiv_id
      ? `https://arxiv.org/abs/${String(record.arxiv_id).replace(/v\d+$/, '')}`
      : record.url ?? (record.doi ? `https://doi.org/${record.doi}` : '')
    return `${trimPeriod(authors)}. ${title}[EB/OL]. ${venue}${year ? `, ${year}` : ''}.${preprintLink ? ` ${preprintLink}.` : ''}`.trim()
  }
  return `${trimPeriod(authors)}. ${title}[J]. ${venue}${locator}.${doi}`.replace(/\s+/g, ' ').trim()
}

/** Nature: Authors. Title. Journal Volume, Pages (Year). doi:... */
export function nature(record) {
  const authors = natureAuthors(authorsOf(record))
  const title = cleanTitle(record)
  const year = yearOf(record)
  const venue = venueOf(record)
  const locator = `${record.volume ? ` ${record.volume}` : ''}${record.pages ? `, ${record.pages}` : ''}`

  if (isPreprint(record)) {
    const preprintLink = record.arxiv_id
      ? `https://arxiv.org/abs/${String(record.arxiv_id).replace(/v\d+$/, '')}`
      : record.url ?? (record.doi ? `https://doi.org/${record.doi}` : '')
    return `${trimPeriod(authors)}. ${title}. ${venue}${preprintLink ? ` ${preprintLink}` : ''}${year ? ` (${year})` : ''}.`
      .replace(/\s+/g, ' ')
      .trim()
  }
  return `${trimPeriod(authors)}. ${title}. ${venue}${locator}${year ? ` (${year})` : ''}.${doiSuffix(record)}`.replace(/\s+/g, ' ').trim()
}

const BIB_ESCAPE = {
  '\\': '\\textbackslash{}',
  '&': '\\&',
  '%': '\\%',
  $: '\\$',
  '#': '\\#',
  _: '\\_',
  '{': '\\{',
  '}': '\\}',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
}

/** Escape LaTeX-special characters in one BibTeX field value. */
export function escapeBibtex(value) {
  return String(value ?? '').replace(/[\\&%$#_{}~^]/g, (character) => BIB_ESCAPE[character])
}

/** `Last, First` BibTeX author form. */
function bibAuthor(raw) {
  const { family, given } = parseName(raw)
  return given ? `${family}, ${given}` : family
}

/** Deterministic BibTeX key: family + year + first title word. */
export function citationKey(record, used = new Set()) {
  const family = parseName(authorsOf(record)[0] ?? '').family
  const year = yearOf(record) || 'nd'
  const word = /[A-Za-z0-9]+/.exec(cleanTitle(record))?.[0] ?? 'paper'
  const base = `${family}${year}${word}`.toLowerCase().replace(/[^a-z0-9]/g, '') || 'reference'
  let key = base
  let suffix = 1
  while (used.has(key)) key = `${base}${(suffix += 1)}`
  used.add(key)
  return key
}

/** One BibTeX entry. */
export function bibtex(record, used = new Set()) {
  const key = citationKey(record, used)
  const authors = authorsOf(record)
  const authorField = authors.length > 20
    ? [...authors.slice(0, 20).map(bibAuthor), 'others'].join(' and ')
    : authors.map(bibAuthor).join(' and ')
  const fields = [
    ['author', authorField],
    ['title', `{${escapeBibtex(cleanTitle(record))}}`],
  ]

  if (isPreprint(record)) {
    const venue = venueOf(record)
    fields.push(['year', yearOf(record)])
    if (record.arxiv_id) {
      fields.push(['eprint', String(record.arxiv_id).replace(/v\d+$/, '')])
      fields.push(['archivePrefix', 'arXiv'])
    } else if (venue !== 'Preprint') {
      fields.push(['howpublished', venue])
    }
    if (record.doi) fields.push(['doi', record.doi])
    if (record.url) fields.push(['url', record.url])
    fields.push(['note', 'Preprint'])
  } else {
    fields.push(['journal', escapeBibtex(venueOf(record))])
    fields.push(['year', yearOf(record)])
    if (record.volume) fields.push(['volume', record.volume])
    if (record.issue) fields.push(['number', record.issue])
    if (record.pages) fields.push(['pages', String(record.pages).replace(/[-–]/g, '--')])
    if (record.doi) fields.push(['doi', record.doi])
    if (record.url) fields.push(['url', record.url])
  }

  const entryType = isPreprint(record) ? 'misc' : 'article'
  const body = fields
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
    .map(([name, value]) => `  ${name} = {${value}}`)
    .join(',\n')
  return `@${entryType}{${key},\n${body}\n}`
}

/** One RIS record. */
export function ris(record) {
  const lines = [isPreprint(record) ? 'TY  - UNPB' : 'TY  - JOUR']
  for (const author of authorsOf(record)) {
    const { family, given } = parseName(author)
    lines.push(`AU  - ${given ? `${family}, ${given}` : family}`)
  }
  lines.push(`TI  - ${cleanTitle(record)}`)
  const venue = venueOf(record)
  if (venue) lines.push(`JO  - ${venue}`)
  if (record.year) lines.push(`PY  - ${record.year}`)
  if (record.volume) lines.push(`VL  - ${record.volume}`)
  if (record.issue) lines.push(`IS  - ${record.issue}`)
  if (record.pages) {
    const [start, end] = String(record.pages).split(/[-–]/)
    lines.push(`SP  - ${start}`)
    if (end) lines.push(`EP  - ${end}`)
  }
  if (record.doi) lines.push(`DO  - ${record.doi}`)
  if (record.url) lines.push(`UR  - ${record.url}`)
  if (record.abstract) lines.push(`AB  - ${String(record.abstract).replace(/\s+/g, ' ')}`)
  lines.push('ER  -')
  return lines.join('\n')
}

/** One CSL-JSON item. */
export function cslJson(record) {
  const item = {
    id: record.doi ?? record.pmid ?? record.arxiv_id ?? record.id,
    type: isPreprint(record) ? 'article' : 'article-journal',
    title: cleanTitle(record),
  }
  const authors = authorsOf(record).map((raw) => {
    const { family, given } = parseName(raw)
    return { family, ...(given ? { given } : {}) }
  })
  if (authors.length > 0) item.author = authors
  if (venueOf(record)) item['container-title'] = venueOf(record)
  if (record.volume) item.volume = String(record.volume)
  if (record.issue) item.issue = String(record.issue)
  if (record.pages) item.page = String(record.pages)
  if (record.year) item.issued = { 'date-parts': [[record.year]] }
  if (record.doi) item.DOI = record.doi
  if (record.url) item.URL = record.url
  if (isPreprint(record)) item.genre = 'preprint'
  return item
}

/** Supported output identifiers. */
export const CITE_OUTPUTS = ['vancouver', 'apa', 'gb-t-7714', 'nature', 'bibtex', 'ris', 'csl-json']

/** Format one record in the requested output. */
export function formatCitation(record, output) {
  switch (output) {
    case 'vancouver':
      return vancouver(record)
    case 'apa':
      return apa(record)
    case 'gb-t-7714':
      return gbT7714(record)
    case 'nature':
      return nature(record)
    case 'bibtex':
      return bibtex(record)
    case 'ris':
      return ris(record)
    case 'csl-json':
      return JSON.stringify(cslJson(record), null, 2)
    default:
      throw new Error(`Unknown citation output "${output}"`)
  }
}

/**
 * Format a batch of resolved records.
 * BibTeX keys and CSL ids are kept unique within the batch.
 *
 * @param {{identifier: string, record: object}[]} items
 * @param {string} output one of {@link CITE_OUTPUTS}
 * @returns {{entries: object[], combined: string}}
 */
export function buildCitations(items, output) {
  const used = new Set()
  const entries = items.map(({ identifier, record }) => {
    const text = output === 'bibtex'
      ? bibtex(record, used)
      : formatCitation(record, output)
    return {
      identifier,
      id: record.doi ?? record.pmid ?? record.arxiv_id ?? record.id,
      title: record.title,
      source: record.source,
      text,
    }
  })

  const combined = output === 'csl-json'
    ? JSON.stringify(entries.map((entry) => {
        const parsed = JSON.parse(entry.text)
        return parsed
      }), null, 2)
    : entries.map((entry) => entry.text).join(output === 'bibtex' ? '\n\n' : '\n\n')

  return { entries, combined }
}

/** Infer an output format from a save path extension. */
export function inferOutputFromPath(path) {
  const lower = String(path ?? '').toLowerCase()
  if (lower.endsWith('.bib')) return 'bibtex'
  if (lower.endsWith('.ris')) return 'ris'
  if (lower.endsWith('.json')) return 'csl-json'
  if (lower.endsWith('.txt') || lower.endsWith('.md')) return 'vancouver'
  return undefined
}
