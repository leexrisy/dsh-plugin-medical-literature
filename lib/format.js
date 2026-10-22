/** Model-facing rendering: compact Markdown that stays cheap in tokens. */

import { truncate } from './text.js'

function authorLine(authors = []) {
  if (!Array.isArray(authors) || authors.length === 0) return ''
  if (authors.length <= 4) return authors.join(', ')
  return `${authors.slice(0, 3).join(', ')}, et al.`
}

function metaLine(record) {
  const parts = []
  if (record.retracted) parts.push('**RETRACTED**')
  if (record.journal) parts.push(`*${record.journal}*`)
  if (record.year) parts.push(String(record.year))
  const volumeIssue = `${record.volume ?? ''}${record.issue ? `(${record.issue})` : ''}`
  const locator = volumeIssue
    ? `${volumeIssue}${record.pages ? `:${record.pages}` : ''}`
    : record.pages
      ? String(record.pages)
      : ''
  if (locator) parts.push(locator)
  if (record.type === 'preprint') parts.push('preprint')
  else if (record.type === 'review') parts.push('review')
  if (Number.isInteger(record.cited_by_count)) parts.push(`cited ${record.cited_by_count}`)
  return parts.join(' · ')
}

function idsLine(record) {
  const ids = []
  if (record.doi) ids.push(`DOI ${record.doi}`)
  if (record.pmid) ids.push(`PMID ${record.pmid}`)
  if (record.arxiv_id) ids.push(`arXiv ${record.arxiv_id}`)
  if (record.pmcid) ids.push(record.pmcid)
  if (ids.length === 0 && record.source && record.id) ids.push(`${record.source}:${record.id}`)

  const links = []
  if (record.url) links.push(`[link](${record.url})`)
  if (record.pdf_url) links.push(`[pdf](${record.pdf_url})`)

  return [...ids.map((value) => `\`${value}\``), ...links].join(' · ')
}

/**
 * Render a search outcome.
 *
 * @param {object} value canonical tool value
 * @param {number} abstractChars 0 disables abstracts
 */
export function formatSearch(value, abstractChars = 600) {
  const { query, queries, sources, counts, totals, removed_duplicates, records, errors, saved_to } = value
  const lines = []

  const heading = query.startsWith('per-source queries')
    ? '### Literature search'
    : `### Literature search: "${query}"`
  lines.push(heading)
  lines.push('')

  if (queries && new Set(Object.values(queries)).size > 1) {
    lines.push(
      `Queries — ${Object.entries(queries)
        .map(([source, text]) => `${source}: \`${text}\``)
        .join(' · ')}`,
    )
    lines.push('')
  }

  const coverage = sources.map((source) => {
    const shown = counts?.[source] ?? 0
    const total = totals?.[source] ?? 0
    return total > shown ? `${source} ${shown}/${total}` : `${source} ${shown}`
  })
  const summary = [`${records.length} unique record${records.length === 1 ? '' : 's'}`]
  if (removed_duplicates > 0) summary.push(`${removed_duplicates} duplicate${removed_duplicates === 1 ? '' : 's'} merged`)
  lines.push(`${summary.join(', ')} — ${coverage.join(' · ')}`)
  if (value.candidates || value.fusion) {
    const sort = value.sort && value.sort !== 'relevance' ? ` · sort ${value.sort}` : ''
    lines.push(`_Recall ${value.candidates ?? '?'}/source · fusion ${value.fusion ?? 'rrf'}${sort}_`)
  }
  lines.push('')

  if (records.length === 0) {
    lines.push('No records found. Try broader keywords, remove the year filter, or select more sources.')
  }

  records.forEach((record, index) => {
    lines.push(`**${index + 1}. ${record.title || '(untitled)'}**`)
    const authors = authorLine(record.authors)
    if (authors) lines.push(authors)
    const meta = metaLine(record)
    if (meta) lines.push(meta)
    lines.push(idsLine(record))
    if (record.abstract && abstractChars > 0) {
      lines.push(`Abstract: ${truncate(record.abstract, abstractChars)}`)
    }
    lines.push('')
  })

  if (errors?.length > 0) {
    lines.push('Warnings:')
    for (const error of errors) lines.push(`- ${error.source}: ${error.message}`)
    lines.push('')
  }

  if (records.length > 0) {
    const notes = []
    if (abstractChars > 0) notes.push(`Abstracts truncated to ${abstractChars} characters (set abstract_chars for longer excerpts).`)
    notes.push('Use medical_literature_get with a DOI, PMID, or arXiv id for one record in full.')
    if (saved_to) notes.push(`Saved to ${saved_to}.`)
    lines.push(`_${notes.join(' ')}_`)
  }

  return lines.join('\n').trimEnd()
}

/** Render one resolved record with its complete abstract. */
export function formatRecord(value) {
  if (!value.found || !value.record) {
    return value.message ?? 'No record found.'
  }
  const record = value.record
  const lines = [`**${record.title || '(untitled)'}**`]

  const authors = authorLine(record.authors)
  if (authors) lines.push(authors)
  const meta = [metaLine(record), record.date].filter(Boolean).join(' · ')
  if (meta) lines.push(meta)
  lines.push(idsLine(record))
  if (record.abstract) {
    lines.push('')
    lines.push('**Abstract**')
    lines.push(record.abstract)
  }
  return lines.join('\n').trimEnd()
}

/** Render a batch of formatted citations. */
export function formatCitations(value) {
  const { output, entries, combined, saved_to, failures } = value
  const lines = []
  const label = output === 'csl-json' ? 'CSL-JSON' : output
  lines.push(`**${entries.length} citation${entries.length === 1 ? '' : 's'} · ${label}**`)
  lines.push('')

  if (output === 'bibtex' || output === 'ris' || output === 'csl-json') {
    const fence = output === 'csl-json' ? 'json' : output
    lines.push(`\`\`\`${fence}`)
    lines.push(combined)
    lines.push('```')
  } else {
    entries.forEach((entry, index) => {
      lines.push(`${index + 1}. ${entry.text}`)
      lines.push('')
    })
  }

  if (failures?.length > 0) {
    lines.push('Warnings:')
    for (const failure of failures) lines.push(`- ${failure.identifier}: ${failure.message}`)
    lines.push('')
  }
  if (saved_to) lines.push(`_Saved to ${saved_to}._`)

  return lines.join('\n').trimEnd()
}

/** Render an acquired full-text result. */
export function formatFulltext(value) {
  if (!value.found) return value.message ?? 'No open-access full text found.'

  const lines = [`**${value.title || value.id}**`]
  const meta = [
    value.source,
    `${value.sections.length} section${value.sections.length === 1 ? '' : 's'}`,
    value.references_count ? `${value.references_count} references` : '',
  ]
    .filter(Boolean)
    .join(' · ')
  lines.push(meta)
  if (value.doi) lines.push(`DOI ${value.doi}`)
  if (value.saved_to) lines.push(`Saved to ${value.saved_to}`)
  lines.push('')
  lines.push('Sections:')
  for (const section of value.sections) {
    lines.push(`- ${'  '.repeat(Math.max(0, section.level - 1))}${section.title} (${section.chars} chars)`)
  }
  if (value.message) {
    lines.push('')
    lines.push(`_${value.message}_`)
  }
  lines.push('')
  lines.push(value.text)
  if (value.truncated) {
    lines.push('')
    lines.push('_Text truncated; the complete document is in the saved file._')
  }
  return lines.join('\n').trimEnd()
}

/** Render an evidence check / reference audit. */
export function formatCheck(value) {
  const { claim, checked, items, duplicates, warnings } = value
  const lines = []
  lines.push(claim ? `**Evidence check: "${truncate(claim, 200)}"**` : '**Reference audit**')
  const summary = [
    `${checked} source${checked === 1 ? '' : 's'}`,
    `${duplicates.length} duplicate group${duplicates.length === 1 ? '' : 's'}`,
    `${warnings.length} warning${warnings.length === 1 ? '' : 's'}`,
  ]
  lines.push(summary.join(' · '))
  lines.push('')

  items.forEach((item, index) => {
    lines.push(`**${index + 1}. ${item.title || item.identifier}**`)
    const meta = [
      item.retracted ? '**RETRACTED**' : '',
      item.pmid ? `PMID ${item.pmid}` : '',
      item.doi ? `DOI ${item.doi}` : '',
      item.journal ? `*${item.journal}*` : '',
      item.year ? String(item.year) : '',
    ]
      .filter(Boolean)
      .join(' · ')
    if (meta) lines.push(meta)
    if (!item.found) {
      lines.push(item.message ?? 'Not found.')
      lines.push('')
      return
    }
    if (claim) {
      const top = item.passages?.[0]
      lines.push(`Evidence: ${item.evidence_source ?? 'none'} · top coverage ${top?.coverage ?? 0}`)
      for (const passage of item.passages ?? []) {
        lines.push(`- [${passage.section}] score ${passage.score} · coverage ${passage.coverage}`)
        lines.push(`  > ${truncate(passage.text, 700).replace(/\s+/g, ' ')}`)
      }
      if ((item.passages ?? []).length === 0) lines.push('- No candidate passage found.')
    }
    lines.push('')
  })

  if (duplicates.length > 0) {
    lines.push('Duplicates:')
    for (const duplicate of duplicates) {
      lines.push(`- ${duplicate.kind} ${duplicate.value}: ${duplicate.identifiers.join(', ')}`)
    }
    lines.push('')
  }
  if (warnings.length > 0) {
    lines.push('Warnings:')
    for (const warning of warnings) lines.push(`- ${warning}`)
  }

  return lines.join('\n').trimEnd()
}
