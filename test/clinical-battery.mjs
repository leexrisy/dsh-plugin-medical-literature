#!/usr/bin/env node
/**
 * Live 12-question clinical retrieval battery (network required; not part of CI).
 *
 *   node test/clinical-battery.mjs        # all 12
 *   node test/clinical-battery.mjs 1 4    # Q1-Q4
 *
 * Each entry is a realistic clinical question decomposed into per-source native
 * queries. Q11 is expected to return zero records; Q12 is a known-item check
 * against EMPEROR-Reduced (PMID 32865377, HR 0.75, 95% CI 0.65-0.86).
 */

import { getByIdentifier } from '../lib/get.js'
import { searchAll } from '../lib/search.js'

const specs = [
  {
    q: 1,
    label: 'SGLT2i vs GLP-1 RA in T2DM+CKD, MACE, RCT',
    sources: ['pubmed', 'europepmc'],
    yearFrom: 2015,
    queries: {
      pubmed: '("Sodium-Glucose Transporter 2 Inhibitors"[MeSH] OR "SGLT2 inhibitor"[tiab] OR "SGLT2 inhibitors"[tiab] OR dapagliflozin[tiab] OR empagliflozin[tiab] OR canagliflozin[tiab]) AND ("Glucagon-Like Peptide-1 Receptor Agonists"[MeSH] OR "GLP-1 receptor agonist"[tiab] OR "GLP-1 receptor agonists"[tiab] OR semaglutide[tiab] OR dulaglutide[tiab] OR liraglutide[tiab]) AND ("Diabetes Mellitus, Type 2"[MeSH] OR "type 2 diabetes"[tiab]) AND ("Renal Insufficiency, Chronic"[MeSH] OR "chronic kidney disease"[tiab] OR CKD[tiab]) AND ("Cardiovascular Diseases"[MeSH] OR MACE[tiab] OR "major adverse cardiovascular events"[tiab]) AND (randomized controlled trial[pt] OR "randomized controlled trial"[tiab] OR "randomised"[tiab])',
      europepmc: '(TITLE_ABS:"SGLT2 inhibitor" OR TITLE_ABS:"SGLT2 inhibitors" OR MESH:"Sodium-Glucose Transporter 2 Inhibitors" OR TITLE_ABS:dapagliflozin OR TITLE_ABS:empagliflozin) AND (TITLE_ABS:"GLP-1 receptor agonist" OR TITLE_ABS:"GLP-1 receptor agonists" OR MESH:"Glucagon-Like Peptide-1 Receptor Agonists" OR TITLE_ABS:semaglutide OR TITLE_ABS:dulaglutide) AND (TITLE_ABS:"type 2 diabetes" OR MESH:"Diabetes Mellitus, Type 2") AND (TITLE_ABS:"chronic kidney disease" OR TITLE_ABS:CKD OR MESH:"Renal Insufficiency, Chronic") AND (TITLE_ABS:MACE OR TITLE_ABS:"major adverse cardiovascular events" OR MESH:"Cardiovascular Diseases") AND (PUB_TYPE:"Randomized Controlled Trial" OR TITLE_ABS:"randomized controlled trial")',
    },
  },
  {
    q: 2,
    label: 'ARDS prone vs supine, 28-day mortality, ICU',
    sources: ['pubmed', 'europepmc'],
    queries: {
      pubmed: '("Respiratory Distress Syndrome"[MeSH] OR ARDS[tiab] OR "acute respiratory distress syndrome"[tiab]) AND ("Respiration, Artificial"[MeSH] OR "mechanical ventilation"[tiab] OR "mechanically ventilated"[tiab]) AND ("Prone Position"[MeSH] OR "prone position"[tiab] OR "prone positioning"[tiab] OR proning[tiab]) AND ("Intensive Care Units"[MeSH] OR ICU[tiab] OR "intensive care"[tiab]) AND (mortality[tiab] OR "28-day mortality"[tiab] OR "28 day mortality"[tiab])',
      europepmc: '(TITLE_ABS:ARDS OR TITLE_ABS:"acute respiratory distress syndrome" OR MESH:"Respiratory Distress Syndrome") AND (TITLE_ABS:"mechanical ventilation" OR TITLE_ABS:"mechanically ventilated" OR MESH:"Respiration, Artificial") AND (TITLE_ABS:"prone position" OR TITLE_ABS:"prone positioning" OR TITLE_ABS:proning OR MESH:"Prone Position") AND (TITLE_ABS:ICU OR TITLE_ABS:"intensive care" OR MESH:"Intensive Care Units") AND (TITLE_ABS:mortality OR TITLE_ABS:"28-day mortality")',
    },
  },
  {
    q: 3,
    label: 'CLDN18.2 CAR-T / bispecific, gastric or GEJ, phase I/II',
    sources: ['pubmed', 'europepmc'],
    queries: {
      pubmed: '("Claudins"[MeSH] OR "claudin 18.2"[tiab] OR "CLDN18.2"[tiab] OR "CLDN18-2"[tiab]) AND ("Receptors, Chimeric Antigen"[MeSH] OR "CAR-T"[tiab] OR "chimeric antigen receptor"[tiab] OR "bispecific antibody"[tiab] OR "bispecific antibodies"[tiab] OR "bispecific"[tiab]) AND ("Stomach Neoplasms"[MeSH] OR gastric[tiab] OR "gastroesophageal"[tiab] OR "gastro-esophageal"[tiab] OR "gastro-oesophageal"[tiab]) AND ("Clinical Trials, Phase I"[pt] OR "Clinical Trials, Phase II"[pt] OR "phase I"[tiab] OR "phase II"[tiab] OR "phase 1"[tiab] OR "phase 2"[tiab])',
      europepmc: '(TITLE_ABS:"claudin 18.2" OR TITLE_ABS:"CLDN18.2" OR MESH:Claudins) AND (TITLE_ABS:"CAR-T" OR TITLE_ABS:"chimeric antigen receptor" OR TITLE_ABS:"bispecific antibody" OR TITLE_ABS:"bispecific antibodies" OR MESH:"Receptors, Chimeric Antigen") AND (TITLE_ABS:gastric OR TITLE_ABS:gastroesophageal OR TITLE_ABS:"gastro-oesophageal" OR MESH:"Stomach Neoplasms") AND (TITLE_ABS:"phase I" OR TITLE_ABS:"phase II" OR TITLE_ABS:"phase 1" OR TITLE_ABS:"phase 2")',
    },
  },
  {
    q: 4,
    label: 'CRISPR / base editing for ATTR, in vivo preclinical or human',
    sources: ['pubmed', 'europepmc', 'biorxiv'],
    queries: {
      pubmed: '("CRISPR-Cas Systems"[MeSH] OR CRISPR[tiab] OR "CRISPR-Cas9"[tiab] OR "base editing"[tiab] OR "base editor"[tiab] OR "prime editing"[tiab]) AND ("Amyloid Neuropathies, Familial"[MeSH] OR "transthyretin amyloidosis"[tiab] OR "ATTR amyloidosis"[tiab] OR "ATTR"[tiab] OR transthyretin[tiab]) AND (in vivo[tiab] OR mice[tiab] OR mouse[tiab] OR "animal model"[tiab] OR preclinical[tiab] OR patients[tiab] OR "first-in-human"[tiab])',
      europepmc: '(TITLE_ABS:CRISPR OR TITLE_ABS:"base editing" OR TITLE_ABS:"base editor" OR MESH:"CRISPR-Cas Systems") AND (TITLE_ABS:"transthyretin amyloidosis" OR TITLE_ABS:"ATTR amyloidosis" OR TITLE_ABS:ATTR OR TITLE_ABS:transthyretin OR MESH:"Amyloid Neuropathies, Familial") AND (TITLE_ABS:"in vivo" OR TITLE_ABS:mice OR TITLE_ABS:preclinical OR TITLE_ABS:patients)',
      biorxiv: 'TITLE_ABS:CRISPR AND (TITLE_ABS:"transthyretin" OR TITLE_ABS:ATTR)',
    },
  },
  {
    q: 5,
    label: 'Sepsis/septic shock fluid resuscitation guidelines, last 3 years',
    sources: ['pubmed', 'europepmc'],
    yearFrom: 2023,
    queries: {
      pubmed: '("Sepsis"[MeSH] OR sepsis[tiab]) AND ("Septic Shock"[MeSH] OR "septic shock"[tiab]) AND ("fluid resuscitation"[tiab] OR "fluid therapy"[MeSH] OR "intravenous fluids"[tiab] OR "fluid bolus"[tiab]) AND ("Guideline"[pt] OR "Practice Guideline"[pt] OR guideline[tiab] OR guidelines[tiab] OR consensus[tiab] OR recommendation[tiab] OR recommendations[tiab])',
      europepmc: '(TITLE_ABS:sepsis OR MESH:Sepsis) AND (TITLE_ABS:"septic shock" OR MESH:"Septic Shock") AND (TITLE_ABS:"fluid resuscitation" OR TITLE_ABS:"fluid therapy" OR TITLE_ABS:"intravenous fluids" OR MESH:"Fluid Therapy") AND (PUB_TYPE:"Guideline" OR PUB_TYPE:"Practice Guideline" OR TITLE_ABS:guideline OR TITLE_ABS:guidelines OR TITLE_ABS:consensus) AND PUB_YEAR:[2023 TO 2026]',
    },
  },
  {
    q: 6,
    label: 'Intermittent fasting, NAFLD/MASLD fibrosis, SR/MA, last 5 years',
    sources: ['pubmed', 'europepmc'],
    yearFrom: 2021,
    queries: {
      pubmed: '("Intermittent Fasting"[MeSH] OR "intermittent fasting"[tiab] OR "time-restricted eating"[tiab] OR "time restricted eating"[tiab] OR "alternate-day fasting"[tiab] OR "alternate day fasting"[tiab]) AND ("Non-alcoholic Fatty Liver Disease"[MeSH] OR NAFLD[tiab] OR MASLD[tiab] OR "metabolic dysfunction-associated steatotic liver disease"[tiab] OR "nonalcoholic fatty liver"[tiab]) AND (fibrosis[tiab] OR "liver fibrosis"[tiab] OR "hepatic fibrosis"[tiab]) AND ("Systematic Review"[pt] OR "Meta-Analysis"[pt] OR "systematic review"[tiab] OR "meta-analysis"[tiab] OR "meta analysis"[tiab])',
      europepmc: '(TITLE_ABS:"intermittent fasting" OR TITLE_ABS:"time-restricted eating" OR MESH:"Intermittent Fasting") AND (TITLE_ABS:NAFLD OR TITLE_ABS:MASLD OR TITLE_ABS:"metabolic dysfunction-associated steatotic liver disease" OR MESH:"Non-alcoholic Fatty Liver Disease") AND (TITLE_ABS:fibrosis OR TITLE_ABS:"liver fibrosis") AND (PUB_TYPE:"Systematic Review" OR PUB_TYPE:"Meta-Analysis" OR TITLE_ABS:"systematic review" OR TITLE_ABS:"meta-analysis") AND PUB_YEAR:[2021 TO 2026]',
    },
  },
  {
    q: 7,
    label: 'ICI myocarditis + myasthenia overlap, case reports',
    sources: ['pubmed', 'europepmc'],
    queries: {
      pubmed: '("Immune Checkpoint Inhibitors"[MeSH] OR "immune checkpoint inhibitor"[tiab] OR "PD-1"[tiab] OR "PD-L1"[tiab] OR pembrolizumab[tiab] OR nivolumab[tiab] OR ipilimumab[tiab]) AND (myocarditis[tiab] OR "Myocarditis"[MeSH]) AND ("Myasthenia Gravis"[MeSH] OR "myasthenia gravis"[tiab] OR "overlap syndrome"[tiab] OR "myositis"[tiab]) AND ("Case Reports"[pt] OR "case report"[tiab])',
      europepmc: '(TITLE_ABS:"immune checkpoint inhibitor" OR TITLE_ABS:"PD-1" OR TITLE_ABS:"PD-L1" OR MESH:"Immune Checkpoint Inhibitors") AND (TITLE_ABS:myocarditis OR MESH:Myocarditis) AND (TITLE_ABS:"myasthenia gravis" OR TITLE_ABS:"overlap syndrome" OR MESH:"Myasthenia Gravis") AND (PUB_TYPE:"Case Reports" OR TITLE_ABS:"case report")',
    },
  },
  {
    q: 8,
    label: 'Dupilumab in early pregnancy, malformation/miscarriage/neonatal, cohort or registry',
    sources: ['pubmed', 'europepmc'],
    queries: {
      pubmed: '(dupilumab[tiab] OR "Dupilumab"[MeSH]) AND ("Pregnancy"[MeSH] OR pregnancy[tiab] OR pregnant[tiab]) AND (malformation[tiab] OR malformations[tiab] OR "congenital anomalies"[tiab] OR "congenital malformations"[tiab] OR miscarriage[tiab] OR "spontaneous abortion"[tiab] OR "neonatal outcomes"[tiab] OR "neonatal outcome"[tiab] OR "birth outcomes"[tiab]) AND ("Cohort Studies"[MeSH] OR cohort[tiab] OR registry[tiab] OR "real-world"[tiab] OR "real world"[tiab])',
      europepmc: '(TITLE_ABS:dupilumab OR MESH:Dupilumab) AND (TITLE_ABS:pregnancy OR TITLE_ABS:pregnant OR MESH:Pregnancy) AND (TITLE_ABS:malformation OR TITLE_ABS:"congenital anomalies" OR TITLE_ABS:miscarriage OR TITLE_ABS:"neonatal outcomes" OR TITLE_ABS:"birth outcomes") AND (TITLE_ABS:cohort OR TITLE_ABS:registry OR TITLE_ABS:"real-world" OR MESH:"Cohort Studies")',
    },
  },
  {
    q: 9,
    label: 'Aspirin colorectal cancer prevention, large long-term evidence',
    sources: ['pubmed', 'europepmc'],
    queries: {
      pubmed: '("Aspirin"[MeSH] OR aspirin[tiab]) AND ("Colorectal Neoplasms"[MeSH] OR "colorectal cancer"[tiab] OR "colon cancer"[tiab] OR "rectal cancer"[tiab] OR "bowel cancer"[tiab]) AND ("Chemoprevention"[MeSH] OR chemoprevention[tiab] OR prevention[tiab] OR preventive[tiab]) AND ("Follow-Up Studies"[MeSH] OR "long-term"[tiab] OR "long term"[tiab] OR "randomized"[tiab] OR "randomised"[tiab] OR "cohort"[tiab])',
      europepmc: '(TITLE_ABS:aspirin OR MESH:Aspirin) AND (TITLE_ABS:"colorectal cancer" OR TITLE_ABS:"colon cancer" OR MESH:"Colorectal Neoplasms") AND (TITLE_ABS:chemoprevention OR TITLE_ABS:prevention OR MESH:Chemoprevention) AND (TITLE_ABS:"long-term" OR TITLE_ABS:"follow-up" OR TITLE_ABS:randomized OR TITLE_ABS:cohort)',
    },
  },
  {
    q: 10,
    label: 'Gut microbiota-gut-brain axis and alpha-synuclein in Parkinson, mechanism reviews',
    sources: ['pubmed', 'europepmc'],
    queries: {
      pubmed: '("Gastrointestinal Microbiome"[MeSH] OR "gut microbiota"[tiab] OR "gut microbiome"[tiab] OR "gut flora"[tiab]) AND ("Brain-Gut Axis"[MeSH] OR "gut-brain axis"[tiab] OR "microbiota-gut-brain"[tiab] OR "gut brain axis"[tiab]) AND ("Parkinson Disease"[MeSH] OR Parkinson[tiab] OR Parkinsonism[tiab]) AND ("alpha-Synuclein"[MeSH] OR "alpha-synuclein"[tiab] OR "α-synuclein"[tiab] OR "synuclein"[tiab]) AND (review[pt] OR "Review"[pt])',
      europepmc: '(TITLE_ABS:"gut microbiota" OR TITLE_ABS:"gut microbiome" OR MESH:"Gastrointestinal Microbiome") AND (TITLE_ABS:"gut-brain axis" OR TITLE_ABS:"microbiota-gut-brain" OR MESH:"Brain-Gut Axis") AND (TITLE_ABS:Parkinson OR MESH:"Parkinson Disease") AND (TITLE_ABS:"alpha-synuclein" OR TITLE_ABS:"α-synuclein" OR MESH:"alpha-Synuclein") AND PUB_TYPE:"review"',
    },
  },
  {
    q: 11,
    label: 'Metformin + hyperbaric oxygen in FOP, double-blind RCT (expected zero)',
    sources: ['pubmed', 'europepmc'],
    queries: {
      pubmed: '(metformin[tiab] OR "Metformin"[MeSH]) AND ("hyperbaric oxygen"[tiab] OR "hyperbaric oxygenation"[tiab] OR "Hyperbaric Oxygenation"[MeSH]) AND ("fibrodysplasia ossificans progressiva"[tiab] OR FOP[tiab] OR "Myositis Ossificans"[MeSH]) AND ("double-blind"[tiab] OR "double blind"[tiab] OR "randomized controlled trial"[pt])',
      europepmc: '(TITLE_ABS:metformin OR MESH:Metformin) AND (TITLE_ABS:"hyperbaric oxygen" OR TITLE_ABS:"hyperbaric oxygenation") AND (TITLE_ABS:"fibrodysplasia ossificans progressiva" OR TITLE_ABS:FOP) AND (TITLE_ABS:"double-blind" OR PUB_TYPE:"Randomized Controlled Trial")',
    },
  },
]

const [from = 1, to = 12] = process.argv.slice(2).map(Number)

for (const spec of specs.filter((entry) => entry.q >= from && entry.q <= to)) {
  const started = Date.now()
  const result = await searchAll({
    queries: spec.queries,
    maxResults: 40,
    finalMaxResults: 6,
    fusion: 'rrf',
    yearFrom: spec.yearFrom,
    yearTo: spec.yearTo,
  })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  console.log(`\n## Q${spec.q}. ${spec.label}`)
  console.log(`totals ${JSON.stringify(result.totals)} · ${seconds}s`)
  if (result.records.length === 0) console.log('(no records)')
  for (const record of result.records) {
    const id = record.pmid ? `PMID ${record.pmid}` : record.doi ?? record.arxiv_id
    console.log(`- ${record.year ?? '?'} ${record.journal ?? ''} — ${record.title.slice(0, 130)} (${id})`)
  }
}

if (from <= 12 && to >= 12) {
  const { found, record } = await getByIdentifier({ identifier: 'PMID:32865377' })
  console.log('\n## Q12. EMPEROR-Reduced metadata')
  if (!found) {
    console.log('NOT FOUND')
  } else {
    console.log(`${record.authors?.[0] ?? 'Unknown'} et al. ${record.journal} ${record.year};${record.volume}(${record.issue}):${record.pages}`)
    console.log(`PMID ${record.pmid} · DOI ${record.doi}`)
    const abstract = String(record.abstract ?? '')
    const at = abstract.indexOf('hazard ratio')
    console.log(at === -1 ? 'hazard ratio sentence not found' : abstract.slice(at, at + 170))
  }
}
