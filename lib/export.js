/**
 * Result export: CSV (Excel-friendly UTF-8 with BOM), JSON, and JSONL.
 * Only the canonical record fields are written; no presentation markup.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, extname } from 'node:path'

/** Column order shared by CSV and the empty-file case. */
export const COLUMNS = [
  'source',
  'id',
  'title',
  'authors',
  'journal',
  'year',
  'date',
  'volume',
  'issue',
  'pages',
  'doi',
  'pmid',
  'arxiv_id',
  'pmcid',
  'url',
  'pdf_url',
  'type',
  'retracted',
  'abstract',
]

function csvCell(value) {
  if (value === undefined || value === null) return ''
  const text = Array.isArray(value) ? value.join('; ') : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function toCsv(records) {
  const header = COLUMNS.join(',')
  const rows = records.map((record) => COLUMNS.map((column) => csvCell(record[column])).join(','))
  // The BOM keeps Excel from mangling non-ASCII author and title characters.
  return `\ufeff${[header, ...rows].join('\r\n')}\r\n`
}

/**
 * Write records to `path`. A missing extension defaults to `.csv`.
 * @returns {Promise<string>} the absolute path written
 */
export async function saveRecords(records, path) {
  let target = path
  const extension = extname(target).toLowerCase()
  if (!extension) target = `${target}.csv`
  const format = extname(target).toLowerCase()

  await mkdir(dirname(target), { recursive: true })

  if (format === '.csv') {
    await writeFile(target, toCsv(records), 'utf8')
  } else if (format === '.json') {
    await writeFile(target, `${JSON.stringify(records, null, 2)}\n`, 'utf8')
  } else if (format === '.jsonl') {
    const body = records.map((record) => JSON.stringify(record)).join('\n')
    await writeFile(target, body ? `${body}\n` : '', 'utf8')
  } else {
    throw new Error(`Unsupported export format "${format}". Use .csv, .json, or .jsonl.`)
  }

  return target
}
