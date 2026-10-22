/**
 * Open-access full text.
 *
 * Two routes avoid the Cloudflare-protected PDF endpoints:
 *   - Europe PMC's JATS XML REST endpoint for PMC articles
 *   - arXiv's HTML rendering for preprints
 *
 * Paywalled articles and bioRxiv/medRxiv preprints have no reliable route, so
 * the tool reports them as unavailable instead of pretending to have text.
 */

import { requestText } from './http.js'
import { getByIdentifier } from './get.js'
import { cleanText, decodeEntities } from './text.js'

const EPMC_XML = 'https://www.ebi.ac.uk/europepmc/webservices/rest'
const ARXIV_HTML = 'https://arxiv.org/html'

/** Extract the inner text of the first `<tag>` element. */
function extractTag(xml, tag) {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(String(xml ?? ''))
  return match ? match[1] : undefined
}

/**
 * Convert a JATS/HTML fragment to readable text while preserving paragraph
 * breaks. `cleanText` collapses newlines, which would destroy section shape.
 *
 * JATS is pretty-printed, so source newlines between tags are noise; a private
 * placeholder marks the breaks we insert and is restored after whitespace is
 * collapsed.
 */
function blockText(html) {
  const BREAK = '\u0000'
  return decodeEntities(
    String(html ?? '')
      .replace(/<p\b[^>]*>/gi, '')
      .replace(/<\/p>/gi, `${BREAK}${BREAK}`)
      .replace(/<list-item\b[^>]*>/gi, `${BREAK}- `)
      .replace(/<\/list-item>/gi, BREAK)
      .replace(/<br\s*\/?>/gi, BREAK)
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\r\n]+/g, ' ')
    .replace(new RegExp(` ?${BREAK} ?`, 'g'), '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Parse JATS `<body>` into a flat list of sections.
 *
 * A stack tracks nested `<sec>` elements so a subsection's text lands in the
 * subsection, and a parent's own paragraphs stay in the parent.
 */
function parseJatsSections(body) {
  const sections = []
  const stack = []
  const token = /<sec\b[^>]*>|<\/sec>|<title\b[^>]*>([\s\S]*?)<\/title>/gi
  let last = 0
  let match

  const pushText = (chunk) => {
    const text = blockText(chunk)
    if (!text) return
    const target = stack[stack.length - 1]
    if (target) {
      target.parts.push(text)
      return
    }
    let intro = sections.find((section) => section.level === 0)
    if (!intro) {
      intro = { title: '', level: 0, parts: [] }
      sections.push(intro)
    }
    intro.parts.push(text)
  }

  while ((match = token.exec(body)) !== null) {
    pushText(body.slice(last, match.index))
    last = token.lastIndex
    const value = match[0]
    if (/^<\/sec/i.test(value)) {
      stack.pop()
    } else if (/^<sec\b/i.test(value)) {
      const section = { title: '', level: stack.length + 1, parts: [] }
      sections.push(section)
      stack.push(section)
    } else {
      const heading = cleanText(match[1])
      const top = stack[stack.length - 1]
      // Only the first title directly inside an unlabelled section names it;
      // table/figure titles must not overwrite the section heading.
      if (heading && top && !top.title) top.title = heading
    }
  }
  pushText(body.slice(last))

  return sections
    .map((section, index) => ({
      title: section.title || (section.level === 0 ? 'Body' : `Section ${index + 1}`),
      level: section.level,
      text: section.parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim(),
    }))
    .filter((section) => section.text.length > 0)
}

/**
 * Parse one Europe PMC JATS XML document.
 * @returns {{title: string, sections: object[], references: string[]}}
 */
export function parseJats(xml) {
  const title = cleanText(extractTag(xml, 'article-title') ?? '')
  const abstractHtml = (extractTag(xml, 'abstract') ?? '').replace(
    /^\s*<title\b[^>]*>[\s\S]*?<\/title>/i,
    '',
  )
  const abstract = blockText(abstractHtml)
  const body = extractTag(xml, 'body') ?? ''
  const refList = extractTag(xml, 'ref-list') ?? ''
  const references = [...refList.matchAll(/<ref\b[^>]*>([\s\S]*?)<\/ref>/gi)]
    .map((match) =>
      blockText(match[1])
        // JATS repeats the list label inside <ref>; the saved Markdown numbers it.
        .replace(/^\s*\d+[.)]?\s+/, '')
        .slice(0, 1000),
    )
    .filter(Boolean)

  const sections = []
  if (abstract) sections.push({ title: 'Abstract', level: 0, text: abstract })
  sections.push(...parseJatsSections(body))

  return { title, sections, references }
}

/**
 * Parse an arXiv HTML rendering into sections by heading.
 * @returns {{title: string, sections: object[], referencesCount: number}}
 */
export function parseArxivHtml(html) {
  const cleaned = String(html ?? '')
    .replace(/<head\b[\s\S]*?<\/head>/gi, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, '')
    .replace(/<header\b[\s\S]*?<\/header>/gi, '')
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, '')

  const titleMatch =
    /<h1[^>]*class="[^"]*ltx_title_document[^"]*"[^>]*>([\s\S]*?)<\/h1>/i.exec(cleaned) ??
    /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(cleaned) ??
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(cleaned)
  const title = cleanText(titleMatch?.[1] ?? '')

  const headings = []
  const headingPattern = /<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi
  let match
  while ((match = headingPattern.exec(cleaned)) !== null) {
    headings.push({
      index: match.index,
      end: headingPattern.lastIndex,
      level: Number(match[1]),
      title: cleanText(match[2]),
    })
  }

  const sections = []
  let start = 0
  let first = 0
  if (headings[0] && title && headings[0].title === title) {
    start = headings[0].end
    first = 1
  }
  const introEnd = headings[first]?.index ?? cleaned.length
  const intro = blockText(cleaned.slice(start, introEnd))
  if (intro) sections.push({ title: 'Abstract', level: 0, text: intro })

  for (let index = first; index < headings.length; index += 1) {
    const heading = headings[index]
    if (!heading.title) continue
    const next = headings[index + 1]?.index ?? cleaned.length
    const text = blockText(cleaned.slice(heading.end, next))
    if (text) sections.push({ title: heading.title, level: heading.level, text })
  }

  const referencesCount = (cleaned.match(/class="[^"]*ltx_bibitem[^"]*"/gi) ?? []).length
  return { title, sections, referencesCount }
}

/** Keep sections whose title contains the filter; fall back to all when none match. */
export function selectSections(sections, filter) {
  if (!filter) return { sections, matched: true }
  const needle = String(filter).toLowerCase()
  const matched = sections.filter((section) => section.title.toLowerCase().includes(needle))
  return matched.length > 0 ? { sections: matched, matched: true } : { sections, matched: false }
}

/**
 * Assemble sections into one bounded text block.
 * @returns {{text: string, truncated: boolean}}
 */
export function assembleText(sections, maxChars) {
  let text = ''
  let truncated = false
  for (const section of sections) {
    const block = `## ${section.title}\n\n${section.text}`
    if (text.length + block.length + 2 > maxChars) {
      const remaining = maxChars - text.length
      if (remaining > 200) text += `${text ? '\n\n' : ''}${block.slice(0, remaining)}`
      truncated = true
      break
    }
    text += `${text ? '\n\n' : ''}${block}`
  }
  return { text: truncated ? `${text.trimEnd()}…` : text, truncated }
}

/** Filesystem-safe directory name for one record id. */
export function sanitizeId(value) {
  return String(value ?? 'record').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'record'
}

function yaml(value) {
  return JSON.stringify(String(value ?? ''))
}

/**
 * Render the saved Markdown document: front matter, sections, references.
 */
export function toMarkdown(result) {
  const lines = [
    '---',
    `title: ${yaml(result.title)}`,
    `source: ${yaml(result.source)}`,
    ...(result.doi ? [`doi: ${yaml(result.doi)}`] : []),
    ...(result.pmid ? [`pmid: ${yaml(result.pmid)}`] : []),
    ...(result.pmcid ? [`pmcid: ${yaml(result.pmcid)}`] : []),
    ...(result.arxiv_id ? [`arxiv_id: ${yaml(result.arxiv_id)}`] : []),
    `retrieved: ${yaml(new Date().toISOString())}`,
    `sections: ${result.sections.length}`,
    `references: ${result.references.length}`,
    ...(result.url ? [`url: ${yaml(result.url)}`] : []),
    '---',
    '',
    `# ${result.title || 'Untitled'}`,
    '',
  ]

  for (const section of result.sections) {
    lines.push(`## ${section.title}`, '', section.text, '')
  }

  if (result.references.length > 0) {
    lines.push('## References', '')
    result.references.forEach((reference, index) => {
      lines.push(`${index + 1}. ${reference}`, '')
    })
  }

  return `${lines.join('\n').trimEnd()}\n`
}

/**
 * Acquire full text for an identifier.
 *
 * @param {object} options
 * @param {string} options.identifier DOI / PMID / PMCID / arXiv id / URL
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<object>} found result with sections, or `{found:false, message}`
 */
export async function fetchFulltext({ identifier, signal }) {
  const resolved = await getByIdentifier({ identifier, signal })
  if (!resolved.found || !resolved.record) {
    return { found: false, message: resolved.message ?? `No record found for "${identifier}".` }
  }
  return fetchFulltextForRecord(resolved.record, signal)
}

/**
 * Acquire full text for an already-resolved record, so callers that already
 * hold a record (the evidence check) do not resolve it twice.
 *
 * @param {object} record normalized record with DOI/PMID/PMCID/arXiv id
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>} found result with sections, or `{found:false, message}`
 */
export async function fetchFulltextForRecord(record, signal) {
  const base = {
    id: record.pmcid ?? record.pmid ?? record.arxiv_id ?? record.doi ?? record.id,
    doi: record.doi,
    pmid: record.pmid,
    pmcid: record.pmcid,
    arxiv_id: record.arxiv_id,
    url: record.url,
    record,
  }
  const failures = []

  if (record.pmcid) {
    try {
      const xml = await requestText(
        `${EPMC_XML}/${encodeURIComponent(record.pmcid)}/fullTextXML`,
        { signal, timeoutMs: 60_000 },
      )
      if (!/<body\b/i.test(xml)) throw new Error('Europe PMC returned no JATS body')
      const parsed = parseJats(xml)
      return {
        found: true,
        source: 'europepmc-xml',
        ...base,
        title: parsed.title || record.title,
        sections: parsed.sections,
        references: parsed.references,
        referencesCount: parsed.references.length,
      }
    } catch (error) {
      failures.push(`Europe PMC XML: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (record.arxiv_id) {
    const arxivId = String(record.arxiv_id).replace(/v\d+$/, '')
    try {
      const html = await requestText(`${ARXIV_HTML}/${encodeURIComponent(arxivId)}`, {
        signal,
        timeoutMs: 60_000,
      })
      if (/Just a moment|Enable JavaScript|cf-browser-verification/i.test(html.slice(0, 4000))) {
        throw new Error('arXiv HTML is behind a browser challenge')
      }
      const parsed = parseArxivHtml(html)
      if (parsed.sections.length === 0) throw new Error('arXiv HTML contained no readable sections')
      return {
        found: true,
        source: 'arxiv-html',
        ...base,
        title: parsed.title || record.title,
        sections: parsed.sections,
        references: [],
        referencesCount: parsed.referencesCount,
      }
    } catch (error) {
      failures.push(`arXiv HTML: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const reason = record.pmcid || record.arxiv_id
    ? `Full text could not be retrieved (${failures.join('; ')}).`
    : record.type === 'preprint'
      ? 'This preprint has no open-access full-text route (bioRxiv/medRxiv PDFs are behind Cloudflare). Use the abstract or open the landing page.'
      : 'No open-access full text: the article is paywalled or not in PubMed Central. Use the abstract, or open the DOI landing page.'

  return { found: false, ...base, message: reason }
}
