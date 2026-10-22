#!/usr/bin/env node
/**
 * Map a clinical phrase to MeSH using PubMed's own automatic term mapping.
 *
 *   node mesh-map.mjs "chronic kidney disease"
 *
 * PubMed (esearch) translates free text into MeSH descriptors and synonyms;
 * that translation is authoritative because it is exactly what a search would
 * run. NLM's MeSH lookup then supplies the descriptor id and entry terms.
 * No API key, no dependencies.
 */

import { get } from 'node:https'

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi'
const LOOKUP = 'https://id.nlm.nih.gov/mesh/lookup'
const UA = 'dsh-plugin-medical-literature/0.6 (mesh-map)'

const phrase = process.argv.slice(2).join(' ').trim()
if (!phrase) {
  console.error('usage: node mesh-map.mjs "<clinical phrase>"')
  process.exit(1)
}

/** HTTPS GET forced to IPv4; NLM's endpoint stalls on Node's default dual-stack connect. */
function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = get(url, { family: 4, headers: { 'user-agent': UA, accept: 'application/json' } }, (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`${response.statusCode} ${response.statusMessage} for ${url}`))
        return
      }
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
      })
      response.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch (error) {
          reject(new Error(`invalid JSON from ${url}: ${error.message}`))
        }
      })
    })
    request.setTimeout(20_000, () => request.destroy(new Error(`timeout for ${url}`)))
    request.on('error', reject)
  })
}

function meshTags(translation) {
  const found = new Map()
  for (const match of String(translation ?? '').matchAll(/"([^"]+)"\[(MeSH Terms|Supplementary Concept)\]/g)) {
    const existing = found.get(match[1])
    if (!existing || match[2] === 'MeSH Terms') found.set(match[1], { label: match[1], kind: match[2] })
  }
  return [...found.values()]
}

const normalize = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

async function descriptor(label) {
  let search = await getJson(
    `${LOOKUP}/descriptor?label=${encodeURIComponent(label)}&match=exact&limit=1`,
  )
  if (search.length === 0) {
    const loose = await getJson(
      `${LOOKUP}/descriptor?label=${encodeURIComponent(label)}&match=contains&limit=8`,
    )
    search = loose.filter((hit) => normalize(hit.label) === normalize(label)).slice(0, 1)
  }
  const hit = search[0]
  if (!hit) return undefined
  const id = hit.resource.split('/').pop()
  const details = await getJson(`${LOOKUP}/details?descriptor=${id}`)
  return {
    id,
    label: hit.label,
    terms: (details.terms ?? []).filter((term) => term.label !== hit.label).map((term) => term.label),
  }
}

const data = await getJson(`${EUTILS}?db=pubmed&retmode=json&retmax=0&term=${encodeURIComponent(phrase)}`)
const result = data.esearchresult ?? {}
const translation = result.querytranslation ?? ''
const tags = meshTags(translation)
const total = Number(result.count ?? 0)

console.log(`Phrase: ${phrase}`)
console.log(`PubMed matches (free text): ${total.toLocaleString('en-US')}`)
if (/^[A-Z]{2,5}$/.test(phrase)) {
  console.log('WARNING: ALL-CAPS acronym. PubMed may map it to an unrelated homonym;')
  console.log('         check the descriptor below before using [All Fields] or bare text.')
}

if (tags.length === 0) {
  console.log('MeSH mapping: none - PubMed did not map this phrase to a descriptor.')
  console.log(`Search it as free text: "${phrase}"[tiab]`)
  process.exit(0)
}

console.log(`PubMed mapped it to: ${translation}`)
for (const tag of tags.slice(0, 3)) {
  console.log(`\n${tag.kind}: ${tag.label}`)
  try {
    const info = await descriptor(tag.label)
    if (info) {
      console.log(`  descriptor: ${info.id}`)
      if (info.terms.length > 0) console.log(`  entry terms: ${info.terms.slice(0, 12).join('; ')}`)
    } else {
      console.log('  (no descriptor record: entry term or supplementary concept)')
    }
  } catch (error) {
    console.log(`  (descriptor lookup failed: ${error.message})`)
  }
}
console.log(
  `\nUse in a query: ${tags.map((tag) => `"${tag.label}"[MeSH Terms]`).join(' OR ')}` +
    `\nPair with free text: "${phrase}"[tiab]`,
)
