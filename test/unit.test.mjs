/**
 * Offline unit tests: parsers, query building, deduplication, identifier
 * classification, citation formatting, full-text parsing, export, and tool
 * registration. No network access.
 *   node --test test/unit.test.mjs
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { apply } from '../index.js'
import { claimTerms, findDuplicates, scorePassages, splitSentences } from '../lib/check.js'
import {
  apa,
  bibtex,
  buildCitations,
  cslJson,
  escapeBibtex,
  gbT7714,
  nature,
  parseName,
  ris,
  vancouver,
} from '../lib/cite.js'
import { saveRecords } from '../lib/export.js'
import { formatCitations, formatCheck, formatFulltext, formatRecord, formatSearch } from '../lib/format.js'
import { parseArxivHtml, parseJats, assembleText, selectSections } from '../lib/fulltext.js'
import { parseIdentifier } from '../lib/get.js'
import { dedupeRecords } from '../lib/normalize.js'
import { resolveQueryPlan } from '../lib/query-plan.js'
import { buildArxivQuery, parseArxivFeed } from '../lib/sources/arxiv.js'
import { parseMedline } from '../lib/sources/pubmed.js'
import { cleanText, normalizePmcid, truncate } from '../lib/text.js'

const RECORD = {
  source: 'pubmed',
  id: '38786024',
  title: 'CRISPR-Based Gene Therapies: From Preclinical to Clinical Treatments',
  authors: ['Laurent M', 'Geoffroy M', 'Pavani G', 'Guiraud S'],
  journal: 'Cells',
  year: 2024,
  volume: '13',
  issue: '10',
  pages: '800-810',
  doi: '10.3390/cells13100800',
  pmid: '38786024',
  url: 'https://pubmed.ncbi.nlm.nih.gov/38786024/',
  type: 'review',
}

const MEDLINE = `PMID- 12345678
TI  - A test title with
      a continuation line.
AB  - Background: something happened.
LID - 10.1000/test.123 [doi]
DP  - 2024 Mar 15
VI  - 13
IP  - 10
PG  - 800-810
AU  - Doe J
AU  - Roe R
JT  - Journal of Tests
PT  - Journal Article
PMC - PMC1234567

PMID- 87654321
TI  - Second record
DP  - 2019
PT  - Review
`

const ARXIV_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>2</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <title>Attention Is All You Need</title>
    <summary>The dominant sequence transduction models are based on complex recurrent networks.</summary>
    <published>2017-06-12T17:57:34Z</published>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <arxiv:doi>10.1000/arxiv.1</arxiv:doi>
    <link href="http://arxiv.org/abs/1706.03762v7" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/1706.03762v7" rel="related" type="application/pdf"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2401.00001v1</id>
    <title>Second Preprint</title>
    <summary>Another abstract.</summary>
    <published>2024-01-01T00:00:00Z</published>
    <author><name>Jane Doe</name></author>
    <link title="pdf" href="http://arxiv.org/pdf/2401.00001v1" rel="related" type="application/pdf"/>
  </entry>
</feed>`

const JATS = `<?xml version="1.0"?>
<article>
  <front>
    <article-title>Test Article</article-title>
    <abstract><p>Abstract text.</p></abstract>
  </front>
  <body>
    <sec><title>Introduction</title><p>Intro text.</p></sec>
    <sec><title>Methods</title><p>Methods text.</p>
      <sec><title>Study design</title><p>Design text.</p></sec>
    </sec>
  </body>
  <back>
    <ref-list>
      <ref id="r1"><mixed-citation>Reference one.</mixed-citation></ref>
      <ref id="r2"><mixed-citation>Reference two.</mixed-citation></ref>
    </ref-list>
  </back>
</article>`

const ARXIV_HTML = `<html><head><title>Doc</title></head><body>
<h1 class="ltx_title_document">My Paper</h1>
<div class="ltx_authors">A. Author</div>
<div class="ltx_abstract"><p>Abstract text.</p></div>
<h2>1 Introduction</h2><p>Intro text.</p>
<h2>2 Methods</h2><p>Methods text.</p>
<div class="ltx_bibitem">Reference</div>
</body></html>`

test('parseMedline reads fields, continuations, DOI, PMC, volume, and types', () => {
  const records = parseMedline(MEDLINE)
  assert.equal(records.length, 2)

  const [first, second] = records
  assert.equal(first.pmid, '12345678')
  assert.equal(first.title, 'A test title with a continuation line.')
  assert.equal(first.abstract, 'Background: something happened.')
  assert.equal(first.doi, '10.1000/test.123')
  assert.equal(first.pmcid, 'PMC1234567')
  assert.equal(first.year, 2024)
  assert.equal(first.date, '2024-03-15')
  assert.equal(first.volume, '13')
  assert.equal(first.issue, '10')
  assert.equal(first.pages, '800-810')
  assert.deepEqual(first.authors, ['Doe J', 'Roe R'])
  assert.equal(first.journal, 'Journal of Tests')
  assert.equal(first.type, 'article')
  assert.equal(first.pdf_url, 'https://europepmc.org/articles/PMC1234567?pdf=render')

  assert.equal(second.pmid, '87654321')
  assert.equal(second.year, 2019)
  assert.equal(second.type, 'review')
  assert.equal(second.doi, undefined)
})

test('parseArxivFeed extracts ids, authors, links, and dates', () => {
  const { records, total } = parseArxivFeed(ARXIV_FEED)
  assert.equal(total, 2)
  assert.equal(records.length, 2)

  const [first, second] = records
  assert.equal(first.arxiv_id, '1706.03762v7')
  assert.equal(first.title, 'Attention Is All You Need')
  assert.deepEqual(first.authors, ['Ashish Vaswani', 'Noam Shazeer'])
  assert.equal(first.doi, '10.1000/arxiv.1')
  assert.equal(first.date, '2017-06-12')
  assert.equal(first.year, 2017)
  assert.equal(first.url, 'https://arxiv.org/abs/1706.03762')
  assert.equal(first.pdf_url, 'https://arxiv.org/pdf/1706.03762v7')
  assert.equal(second.journal, undefined)
})

test('buildArxivQuery preserves syntax and removes stopwords', () => {
  assert.equal(buildArxivQuery('ti:transformer AND au:vaswani'), 'ti:transformer AND au:vaswani')
  assert.equal(buildArxivQuery('attention is all you need'), 'all:attention AND all:all AND all:need')
  assert.equal(buildArxivQuery('"attention is all you need"'), 'all:"attention is all you need"')
  assert.equal(buildArxivQuery('CRISPR base editing'), 'all:CRISPR AND all:base AND all:editing')
})

test('dedupeRecords merges DOI duplicates and keeps the richer record', () => {
  const pubmed = {
    source: 'pubmed',
    id: '1',
    title: 'A shared paper title long enough to match',
    doi: '10.1000/ABC',
    pmid: '1',
    abstract: 'abstract',
    url: 'https://pubmed.ncbi.nlm.nih.gov/1/',
  }
  const europepmc = {
    source: 'europepmc',
    id: '2',
    title: 'A shared paper title long enough to match',
    doi: '10.1000/abc',
    pmcid: 'PMC9',
    pdf_url: 'https://example.org/paper.pdf',
    volume: '7',
    pages: '1-9',
    url: 'https://europepmc.org/article/MED/2',
  }
  const other = {
    source: 'arxiv',
    id: '2401.00001',
    title: 'A completely different paper about something else',
    url: 'https://arxiv.org/abs/2401.00001',
  }

  const { records, removed } = dedupeRecords([pubmed, europepmc, other])
  assert.equal(records.length, 2)
  assert.equal(removed, 1)
  assert.equal(records[0].source, 'pubmed')
  assert.equal(records[0].pdf_url, 'https://example.org/paper.pdf')
  assert.equal(records[0].pmcid, 'PMC9')
  assert.equal(records[0].volume, '7')
  assert.equal(records[0].pages, '1-9')
})

test('dedupeRecords does not merge short or different titles', () => {
  const a = { source: 'arxiv', id: '1', title: 'Short', url: 'u1' }
  const b = { source: 'arxiv', id: '2', title: 'Short', url: 'u2' }
  assert.equal(dedupeRecords([a, b]).records.length, 2)
})

test('retraction markers are surfaced and survive dedupe', () => {
  const [record] = parseMedline('PMID- 1\nTI  - RETRACTED: Something\nPT  - Retracted Publication\n')
  assert.equal(record.retracted, true)
  assert.match(formatRecord({ found: true, record: { ...record, url: 'u' } }), /RETRACTED/)

  const merged = dedupeRecords([
    { source: 'pubmed', id: '1', title: 'A shared title long enough to match', url: 'u1' },
    { source: 'europepmc', id: '2', title: 'A shared title long enough to match', url: 'u2', retracted: true },
  ])
  assert.equal(merged.records.length, 1)
  assert.equal(merged.records[0].retracted, true)
})

test('parseIdentifier classifies DOIs, PMIDs, PMCIDs, and arXiv ids', () => {
  assert.deepEqual(parseIdentifier('10.1038/s41586-020-2649-2'), {
    kind: 'doi',
    value: '10.1038/s41586-020-2649-2',
  })
  assert.deepEqual(parseIdentifier('https://doi.org/10.1038/s41586-020-2649-2'), {
    kind: 'doi',
    value: '10.1038/s41586-020-2649-2',
  })
  assert.deepEqual(parseIdentifier('PMID: 12345'), { kind: 'pmid', value: '12345' })
  assert.deepEqual(parseIdentifier('12345'), { kind: 'pmid', value: '12345' })
  assert.deepEqual(parseIdentifier('PMC7654321'), { kind: 'pmcid', value: 'PMC7654321' })
  assert.deepEqual(parseIdentifier('arXiv:2401.12345'), { kind: 'arxiv', value: '2401.12345' })
  assert.deepEqual(parseIdentifier('https://arxiv.org/abs/1706.03762v7'), {
    kind: 'arxiv',
    value: '1706.03762',
  })
  assert.equal(parseIdentifier('CRISPR off-target review').kind, 'query')
})

test('resolveQueryPlan supports shared and per-source queries', () => {
  const shared = resolveQueryPlan({ query: ' CRISPR ', sources: ['pubmed', 'arxiv'] })
  assert.equal(shared.display, 'CRISPR')
  assert.deepEqual(shared.bySource, { pubmed: 'CRISPR', arxiv: 'CRISPR' })

  const perSource = resolveQueryPlan({
    queries: { pubmed: 'CRISPR[tiab]', arxiv: 'abs:CRISPR' },
    sources: ['pubmed', 'arxiv'],
  })
  assert.deepEqual(perSource.bySource, { pubmed: 'CRISPR[tiab]', arxiv: 'abs:CRISPR' })
  assert.match(perSource.display, /per-source queries/)

  const mixed = resolveQueryPlan({
    query: 'fallback',
    queries: { pubmed: 'CRISPR[tiab]' },
    sources: ['pubmed', 'arxiv'],
  })
  assert.deepEqual(mixed.bySource, { pubmed: 'CRISPR[tiab]', arxiv: 'fallback' })

  assert.throws(() => resolveQueryPlan({ queries: { scopus: 'x' }, sources: ['scopus'] }), /unknown source/)
  assert.throws(() => resolveQueryPlan({ queries: { pubmed: '  ' }, sources: ['pubmed'] }), /non-empty/)
  assert.throws(
    () => resolveQueryPlan({ queries: { pubmed: 'x' }, sources: ['pubmed', 'arxiv'] }),
    /No query for source "arxiv"/,
  )
  assert.throws(() => resolveQueryPlan({ sources: ['pubmed'] }), /Provide query/)
})

test('resolveQueryPlan rejects cross-engine field syntax', () => {
  assert.throws(
    () => resolveQueryPlan({ queries: { pubmed: 'TITLE_ABS:CRISPR' }, sources: ['pubmed'] }),
    /Europe PMC field syntax/,
  )
  assert.throws(
    () => resolveQueryPlan({ queries: { europepmc: 'CRISPR[tiab]' }, sources: ['europepmc'] }),
    /PubMed bracket tags/,
  )
  assert.throws(
    () => resolveQueryPlan({ queries: { arxiv: 'MESH:"Gene Editing"' }, sources: ['arxiv'] }),
    /Europe PMC field syntax/,
  )
  assert.throws(
    () => resolveQueryPlan({ query: 'CRISPR[tiab]', sources: ['pubmed', 'europepmc'] }),
    /source "europepmc"/,
  )

  const plan = resolveQueryPlan({
    queries: {
      pubmed: 'CRISPR[tiab] AND 2024:2026[dp]',
      europepmc: 'TITLE_ABS:CRISPR AND PUB_YEAR:[2024 TO 2026]',
      arxiv: 'abs:CRISPR AND cat:q-bio.QM',
    },
    sources: ['pubmed', 'europepmc', 'arxiv'],
  })
  assert.deepEqual(Object.keys(plan.bySource), ['pubmed', 'europepmc', 'arxiv'])
})

test('text helpers clean markup and truncate on words', () => {
  assert.equal(cleanText('<jats:p>Hello &amp; <i>world</i>.</jats:p>'), 'Hello & world .')
  assert.equal(normalizePmcid('1234567'), 'PMC1234567')
  assert.equal(truncate('one two three four', 9), 'one two…')
})

test('parseName handles PubMed, arXiv, comma, and multi-word families', () => {
  assert.deepEqual(parseName('Laurent M'), { family: 'Laurent', given: 'M' })
  assert.deepEqual(parseName('Ashish Vaswani'), { family: 'Vaswani', given: 'Ashish' })
  assert.deepEqual(parseName('van der Walt SJ'), { family: 'van der Walt', given: 'SJ' })
  assert.deepEqual(parseName('Doe, John'), { family: 'Doe', given: 'John' })
})

test('citation styles format a journal article', () => {
  assert.equal(
    vancouver(RECORD),
    'Laurent M, Geoffroy M, Pavani G, Guiraud S. CRISPR-Based Gene Therapies: From Preclinical to Clinical Treatments. Cells. 2024;13(10):800-810. doi:10.3390/cells13100800',
  )
  assert.equal(
    apa(RECORD),
    'Laurent, M., Geoffroy, M., Pavani, G., & Guiraud, S. (2024). CRISPR-Based Gene Therapies: From Preclinical to Clinical Treatments. Cells, 13(10), 800-810. https://doi.org/10.3390/cells13100800',
  )
  assert.match(gbT7714(RECORD), /^LAURENT M, GEOFFROY M, PAVANI G, et al\. .*\[J\]\. Cells, 2024, 13\(10\): 800-810\. DOI:10\.3390\/cells13100800\.$/)
  assert.equal(
    nature(RECORD),
    'Laurent, M., Geoffroy, M., Pavani, G. & Guiraud, S. CRISPR-Based Gene Therapies: From Preclinical to Clinical Treatments. Cells 13, 800-810 (2024). doi:10.3390/cells13100800',
  )
})

test('preprint citations use the actual preprint server', () => {
  const bioRxiv = {
    source: 'europepmc',
    title: 'A bioRxiv preprint title long enough',
    authors: ['Guan M'],
    year: 2025,
    doi: '10.1101/2025.11.23.688074',
    url: 'https://europepmc.org/article/PPR/PPR1125819',
    type: 'preprint',
  }
  assert.match(vancouver(bioRxiv), /\[Preprint\]\. bioRxiv\./)
  assert.doesNotMatch(vancouver(bioRxiv), /arXiv/)
  assert.match(bibtex(bioRxiv), /howpublished = \{bioRxiv\}/)
})

test('BibTeX, RIS, and CSL-JSON formats are valid', () => {
  const bib = bibtex(RECORD)
  assert.match(bib, /^@article\{laurent2024crispr,/)
  assert.match(bib, /author = \{Laurent, M and Geoffroy, M and Pavani, G and Guiraud, S\}/)
  assert.match(bib, /journal = \{Cells\}/)
  assert.match(bib, /number = \{10\}/)
  assert.match(bib, /pages = \{800--810\}/)
  assert.match(bib, /doi = \{10\.3390\/cells13100800\}/)

  const risText = ris(RECORD)
  assert.match(risText, /^TY {2}- JOUR/m)
  assert.match(risText, /AU {2}- Laurent, M/)
  assert.match(risText, /SP {2}- 800/)
  assert.match(risText, /EP {2}- 810/)
  assert.match(risText, /ER {2}-/)

  const csl = cslJson(RECORD)
  assert.equal(csl.type, 'article-journal')
  assert.equal(csl.author[0].family, 'Laurent')
  assert.equal(csl.volume, '13')
  assert.equal(csl.page, '800-810')

  assert.equal(escapeBibtex('A & B_C'), 'A \\& B\\_C')
})

test('buildCitations keeps BibTeX keys unique within a batch', () => {
  const { entries, combined } = buildCitations(
    [
      { identifier: 'a', record: RECORD },
      { identifier: 'b', record: { ...RECORD, doi: '10.1000/other' } },
    ],
    'bibtex',
  )
  assert.equal(entries.length, 2)
  const keys = [...combined.matchAll(/^@article\{([^,]+),/gm)].map((match) => match[1])
  assert.equal(new Set(keys).size, 2)
})

test('parseJats returns abstract, nested sections, and references', () => {
  const parsed = parseJats(JATS)
  assert.equal(parsed.title, 'Test Article')
  assert.deepEqual(
    parsed.sections.map((section) => section.title),
    ['Abstract', 'Introduction', 'Methods', 'Study design'],
  )
  assert.equal(parsed.sections[3].level, 2)
  assert.equal(parsed.references.length, 2)
  assert.match(parsed.references[0], /Reference one/)
})

test('parseArxivHtml returns abstract, headings, and reference count', () => {
  const parsed = parseArxivHtml(ARXIV_HTML)
  assert.equal(parsed.title, 'My Paper')
  assert.deepEqual(parsed.sections.map((section) => section.title), ['Abstract', '1 Introduction', '2 Methods'])
  assert.equal(parsed.referencesCount, 1)
})

test('JATS references collapse pretty-printed newlines and the label', () => {
  const xml = `<article>
  <front><article-title>T</article-title></front>
  <body><sec><title>X</title><p>x</p></sec></body>
  <back><ref-list><ref id="r1"><label>1</label><element-citation>
    <person-group>
      <name><surname>Wang</surname><given-names>J.Y.</given-names></name>
      <name><surname>Doudna</surname><given-names>J.A.</given-names></name>
    </person-group>
    <article-title>Crispr technology</article-title>
  </element-citation></ref></ref-list></back>
</article>`
  const { references } = parseJats(xml)
  assert.equal(references.length, 1)
  assert.doesNotMatch(references[0], /\n/)
  assert.match(references[0], /^Wang J\.Y\. Doudna J\.A\. Crispr technology$/)
})

test('full-text selection and bounding behave', () => {
  const sections = [
    { title: 'Introduction', level: 1, text: 'a'.repeat(100) },
    { title: 'Methods', level: 1, text: 'b'.repeat(100) },
  ]
  assert.equal(selectSections(sections, 'method').sections[0].title, 'Methods')
  assert.equal(selectSections(sections, 'missing').matched, false)

  const { text, truncated } = assembleText(sections, 150)
  assert.equal(truncated, true)
  assert.ok(text.length <= 151)
})

test('claim terms and passage scoring are lexical but explainable', () => {
  const terms = claimTerms('The CRISPR base editors do not generate double-strand breaks')
  assert.ok(terms.includes('crispr'))
  assert.ok(terms.includes('editor'))
  assert.ok(!terms.includes('the'))
  assert.ok(!terms.includes('not'))

  const ranked = scorePassages(
    [
      { section: 'Base editing', text: 'Base editing does not generate double strand breaks.' },
      { section: 'Cas9', text: 'Cas9 generates double strand breaks.' },
    ],
    ['base', 'editing', 'double', 'strand', 'break'],
  )
  assert.equal(ranked[0].section, 'Base editing')
  assert.equal(ranked[0].coverage, 1)
})

test('splitSentences keeps abbreviations together', () => {
  assert.deepEqual(
    splitSentences('This is the first fairly long sentence about CRISPR editing. This is the second fairly long sentence about base editors.'),
    [
      'This is the first fairly long sentence about CRISPR editing.',
      'This is the second fairly long sentence about base editors.',
    ],
  )
  assert.deepEqual(
    splitSentences('Use CRISPR, e.g. Cas9, for editing and then verify the result carefully. Done with the experiment.'),
    [
      'Use CRISPR, e.g. Cas9, for editing and then verify the result carefully.',
      'Done with the experiment.',
    ],
  )
})

test('findDuplicates groups the same DOI and deduplicates the group', () => {
  const duplicates = findDuplicates([
    { identifier: 'DOI A', found: true, record: { doi: '10.1000/x', title: 'A title long enough to match' } },
    { identifier: 'PMID 1', found: true, record: { doi: '10.1000/X', title: 'A title long enough to match' } },
  ])
  assert.equal(duplicates.length, 1)
  assert.deepEqual(duplicates[0].identifiers, ['DOI A', 'PMID 1'])
})

test('saveRecords writes CSV, JSON, and JSONL', async () => {
  const records = [
    {
      source: 'pubmed',
      id: '1',
      title: 'Title, with "quotes"',
      authors: ['Doe J', 'Roe R'],
      year: 2024,
      volume: '3',
      issue: '2',
      pages: '10-20',
      url: 'https://example.org/1',
    },
  ]

  const csvPath = await saveRecords(records, '/tmp/dsh-medical-lit-test.csv')
  const csv = await readFile(csvPath, 'utf8')
  assert.ok(csv.startsWith('\ufeffsource,id,title'))
  assert.match(csv, /"Title, with ""quotes"""/)
  assert.match(csv, /Doe J; Roe R/)
  assert.match(csv, /,3,2,10-20,/)

  const jsonPath = await saveRecords(records, '/tmp/dsh-medical-lit-test.json')
  assert.deepEqual(JSON.parse(await readFile(jsonPath, 'utf8')), records)

  const jsonlPath = await saveRecords(records, '/tmp/dsh-medical-lit-test.jsonl')
  assert.equal((await readFile(jsonlPath, 'utf8')).trim().split('\n').length, 1)

  const noExtension = await saveRecords(records, '/tmp/dsh-medical-lit-test-noext')
  assert.equal(noExtension, '/tmp/dsh-medical-lit-test-noext.csv')
})

/** Minimal mirror of DSH's enforced schema subset. */
const ALLOWED_SCHEMA_KEYS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
])

function assertSchema(node, path = '$') {
  assert.equal(typeof node, 'object', `${path} must be an object`)
  for (const key of Object.keys(node)) {
    assert.ok(ALLOWED_SCHEMA_KEYS.has(key), `${path} uses unsupported keyword ${key}`)
  }
  if (node.type === 'object' && node.properties !== undefined) {
    assert.equal(typeof node.properties, 'object', `${path} object needs properties`)
    if (node.required !== undefined) {
      assert.ok(Array.isArray(node.required), `${path}.required must be an array`)
      for (const name of node.required) assert.ok(node.properties[name], `${path}.required names unknown ${name}`)
    }
    for (const [name, child] of Object.entries(node.properties)) assertSchema(child, `${path}.${name}`)
  }
  if (node.type === 'array') assertSchema(node.items, `${path}[]`)
}

test('apply registers all five tools with valid schemas', () => {
  const registered = new Map()
  const ctx = {
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    },
    get: () => undefined,
  }

  apply(ctx)
  assert.deepEqual([...registered.keys()].sort(), [
    'medical_literature_check',
    'medical_literature_cite',
    'medical_literature_fulltext',
    'medical_literature_get',
    'medical_literature_search',
  ])

  for (const definition of registered.values()) {
    assert.ok(definition.description.length > 20)
    assert.equal(definition.parameters.type, 'object')
    assert.ok(!definition.parameters.required || Array.isArray(definition.parameters.required))
    assert.equal(typeof definition.output.render, 'function')
    assertSchema(definition.parameters, `${definition.name}.parameters`)
    assertSchema(definition.output.schema, `${definition.name}.output`)
  }
})

test('renderers produce Markdown for search, records, citations, and full text', () => {
  const searchText = formatSearch(
    {
      query: 'test',
      sources: ['pubmed'],
      counts: { pubmed: 1 },
      totals: { pubmed: 10 },
      removed_duplicates: 0,
      errors: [],
      records: [
        {
          source: 'pubmed',
          id: '1',
          title: 'A paper',
          authors: ['Doe J', 'Roe R'],
          journal: 'Journal',
          year: 2024,
          doi: '10.1000/x',
          url: 'https://example.org/1',
        },
      ],
    },
    200,
  )
  assert.match(searchText, /Literature search: "test"/)
  assert.match(searchText, /A paper/)
  assert.match(searchText, /DOI 10\.1000\/x/)
  assert.doesNotMatch(searchText, /pubmed:1/)

  const citedText = formatSearch(
    {
      query: 'per-source queries',
      queries: { europepmc: 'TITLE_ABS:aspirin' },
      sources: ['europepmc'],
      counts: { europepmc: 1 },
      totals: { europepmc: 607 },
      removed_duplicates: 0,
      errors: [],
      candidates: 6,
      fusion: 'source',
      sort: 'cited',
      records: [
        {
          source: 'europepmc',
          id: '1',
          title: 'Landmark aspirin trial',
          year: 2010,
          cited_by_count: 1005,
          url: 'https://europepmc.org/article/MED/1',
        },
      ],
    },
    0,
  )
  assert.match(citedText, /sort cited/)
  assert.match(citedText, /cited 1005/)

  const recordText = formatRecord({
    found: true,
    record: {
      source: 'arxiv',
      id: '2401.1',
      title: 'T',
      url: 'https://arxiv.org/abs/2401.1',
      abstract: 'A.',
      volume: '13',
      issue: '10',
      pages: '800',
    },
  })
  assert.match(recordText, /Abstract/)
  assert.match(recordText, /13\(10\):800/)

  const citeText = formatCitations({
    output: 'bibtex',
    entries: [{ identifier: 'x', text: bibtex(RECORD) }],
    combined: bibtex(RECORD),
    saved_to: '/tmp/refs.bib',
  })
  assert.match(citeText, /```bibtex/)
  assert.match(citeText, /Saved to \/tmp\/refs\.bib/)

  const fulltextText = formatFulltext({
    found: true,
    id: 'PMC1',
    source: 'europepmc-xml',
    title: 'T',
    sections: [{ title: 'Introduction', level: 1, chars: 10 }],
    text: '## Introduction\n\nHello.',
    truncated: false,
    references_count: 3,
  })
  assert.match(fulltextText, /Introduction \(10 chars\)/)
  assert.match(fulltextText, /## Introduction/)
})

test('renderers show the per-source query map', () => {
  const text = formatSearch({
    query: 'per-source queries (pubmed, arxiv)',
    queries: { pubmed: 'CRISPR[tiab]', arxiv: 'abs:CRISPR' },
    sources: ['pubmed', 'arxiv'],
    counts: { pubmed: 0, arxiv: 0 },
    totals: { pubmed: 0, arxiv: 0 },
    removed_duplicates: 0,
    records: [],
    errors: [],
  })
  assert.match(text, /Queries — pubmed: `CRISPR\[tiab\]` · arxiv: `abs:CRISPR`/)
})

test('check renderer shows passages, retractions, duplicates, and warnings', () => {
  const text = formatCheck({
    claim: 'Base editing does not break DNA',
    checked: 1,
    items: [
      {
        identifier: 'PMID: 1',
        found: true,
        title: 'A paper',
        retracted: true,
        evidence_source: 'europepmc-xml',
        passages: [{ section: 'Introduction', score: 4.2, coverage: 0.67, text: 'A supporting passage.' }],
      },
    ],
    duplicates: [{ kind: 'doi', value: '10.1000/x', identifiers: ['PMID: 1', 'DOI 2'] }],
    warnings: ['Polarity differs between the claim and the top passage.'],
  })
  assert.match(text, /Evidence check/)
  assert.match(text, /RETRACTED/)
  assert.match(text, /A supporting passage\./)
  assert.match(text, /Duplicates:/)
  assert.match(text, /doi 10\.1000\/x/)
  assert.match(text, /Polarity differs/)
})
