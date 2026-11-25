// Parse every captured line again with the current parse.js and the apps' corrections: run after
// adding a parser, a category or fixing a regex. Prints the result; the inputs are never written
// (`just reparse` puts it in ~/.local/share/expenses/). Probes and repeated pushes are dropped
// (parse.js reparseLines, shared with the Expenses apps).
//   node reparse.mjs [file ...] > out.json      (files given: no corrections applied)
// Without files: iCloud Drive → Shortcuts → Expenses: every <device>-<year>.json and
// archive-*.json (what was captured) and every edits-<device>.json (what the apps corrected). Each
// file has one writer. Lines still in the old layout (Shortcuts/payments.json, manual-*.json) are
// read too until they are archived.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import lib from './parse.js'

const SHORTCUTS = `${homedir()}/Library/Mobile Documents/iCloud~is~workflow~my~workflows/Documents`
const FOLDER = `${SHORTCUTS}/Expenses`

const json = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [])

function files() {
  const legacy = json(SHORTCUTS).filter((f) => f === 'payments.json' || /^manual-.+\.json$/.test(f))
    .map((f) => `${SHORTCUTS}/${f}`)
  const data = json(FOLDER).filter((f) => f !== 'upload.json' && !f.startsWith('edits-')).map((f) => `${FOLDER}/${f}`)
  const edits = json(FOLDER).filter((f) => f.startsWith('edits-')).map((f) => `${FOLDER}/${f}`)
  return { data: [...legacy, ...data], edits }
}

const read = (paths) => paths.map((f) => readFileSync(f, 'utf8')).join('\n')
const given = process.argv.slice(2)
const { data, edits } = given.length ? { data: given, edits: [] } : files()
for (const n of lib.reparseLines(read(data), read(edits))) process.stdout.write(JSON.stringify(n) + '\n')
