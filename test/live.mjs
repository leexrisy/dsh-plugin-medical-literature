/**
 * Live integration smoke test. Hits the real public APIs; run manually:
 *   node test/live.mjs
 *   node test/live.mjs "single cell atlas"
 */

import assert from 'node:assert/strict'
import { runCheck } from '../lib/check.js'
import { buildCitations } from '../lib/cite.js'
import { saveRecords } from '../lib/export.js'
import { formatCitations, formatFulltext, formatRecord, formatSearch } from '../lib/format.js'
import { fetchFulltext } from '../lib/fulltext.js'
import { getByIdentifier } from '../lib/get.js'
import { searchAll } from '../lib/search.js'

const query = process.argv[2] ?? 'CRISPR base editing'
const yearFrom = 2023

async function main() {
  console.log(`\n=== multi-source search: ${query} (>= ${yearFrom}) ===`)
  const outcome = await searchAll({
    query,
    sources: ['pubmed', 'europepmc', 'arxiv', 'biorxiv'],
    maxResults: 4,
    yearFrom,
    sort: 'date',
  })
  console.log(
    JSON.stringify(
      { counts: outcome.counts, totals: outcome.totals, merged: outcome.removedDuplicates, errors: outcome.errors },
      null,
      2,
    ),
  )
  assert.ok(outcome.records.length > 0, 'expected at least one record')
  for (const record of outcome.records.slice(0, 6)) {
    console.log(`- [${record.source}] ${record.year ?? '?'} ${record.title.slice(0, 90)}`)
  }
  const text = formatSearch(
    { ...outcome, query, sources: ['pubmed', 'europepmc', 'arxiv', 'biorxiv'], removed_duplicates: outcome.removedDuplicates },
    300,
  )
  assert.match(text, /Literature search/)
  console.log(`\n${text.split('\n').slice(0, 12).join('\n')}\n...`)

  const saved = await saveRecords(outcome.records, '/tmp/dsh-medical-literature-smoke.csv')
  console.log(`saved ${outcome.records.length} records to ${saved}`)

  console.log('\n=== get by DOI ===')
  const byDoi = await getByIdentifier({ identifier: '10.1038/s41586-020-2649-2' })
  console.log(byDoi.found, byDoi.record?.title, byDoi.record?.source, byDoi.record?.volume)
  assert.equal(byDoi.found, true)
  assert.match(formatRecord(byDoi), /Abstract/)

  console.log('\n=== get by arXiv id ===')
  const byArxiv = await getByIdentifier({ identifier: 'arXiv:1706.03762' })
  console.log(byArxiv.found, byArxiv.record?.title, byArxiv.record?.source)
  assert.equal(byArxiv.found, true)

  console.log('\n=== cite (BibTeX + Vancouver) ===')
  const bib = buildCitations([{ identifier: byDoi.record.doi, record: byDoi.record }], 'bibtex')
  assert.match(bib.combined, /^@article\{/)
  const van = buildCitations(
    [
      { identifier: byDoi.record.doi, record: byDoi.record },
      { identifier: byArxiv.record.arxiv_id, record: byArxiv.record },
    ],
    'vancouver',
  )
  console.log(van.combined)
  console.log(formatCitations({ ...van, output: 'vancouver' }).split('\n').slice(0, 3).join('\n'))

  console.log('\n=== full text (Europe PMC XML) ===')
  const full = await fetchFulltext({ identifier: 'PMID: 38786024' })
  console.log(full.found, full.source, full.title?.slice(0, 70), `${full.sections?.length} sections`, `${full.references?.length} refs`)
  assert.equal(full.found, true)
  assert.ok(full.sections.length > 5)
  assert.ok(full.references.length > 0)
  console.log(formatFulltext({
    found: true,
    id: full.id,
    source: full.source,
    title: full.title,
    sections: full.sections.slice(0, 5).map((section) => ({ title: section.title, level: section.level, chars: section.text.length })),
    text: full.sections[0].text.slice(0, 400),
    truncated: true,
    references_count: full.references.length,
  }).split('\n').slice(0, 10).join('\n'))

  console.log('\n=== full text (arXiv HTML) ===')
  const arxivFull = await fetchFulltext({ identifier: 'arXiv:1706.03762' })
  console.log(arxivFull.found, arxivFull.source, arxivFull.title, `${arxivFull.sections?.length} sections`, `${arxivFull.referencesCount} refs`)
  assert.equal(arxivFull.found, true)
  assert.ok(arxivFull.sections.length > 5)

  console.log('\n=== check (claim + reference audit) ===')
  const checked = await runCheck({
    claim: 'CRISPR-based therapy has been approved for sickle cell disease',
    identifiers: ['PMID: 38786024', '10.3390/cells13100800'],
    topK: 2,
  })
  console.log('passages:', checked.items[0].passages.map((p) => [p.section, p.coverage]))
  console.log('duplicates:', checked.duplicates, 'warnings:', checked.warnings)
  assert.ok(checked.items[0].passages.length > 0)
  assert.ok(checked.duplicates.length >= 1)

  console.log('\nAll live checks passed.')
}

main().catch((error) => {
  console.error('\nLIVE TEST FAILED:', error)
  process.exitCode = 1
})
