// Parse every line the phone and the "Log Expense" shortcut wrote, again, with the current
// parse.js: run after adding a parser, a category or fixing a regex. Prints the result; the inputs
// are never written (`just reparse` puts it in ~/.local/share/expenses/). The received fields pass
// through as is; probes and repeated pushes are dropped (parse.js reparseLines, shared with the
// Expenses app).
//   node reparse.mjs [file ...] > out.json
// Without files: payments.json (the phone's pushes) and every manual-<device>.json (hand-typed
// payments, one file per device so each has one writer) in iCloud Drive's Shortcuts folder.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import lib from './parse.js'

const ICLOUD = `${homedir()}/Library/Mobile Documents/iCloud~is~workflow~my~workflows/Documents`

function files() {
  if (process.argv.length > 2) return process.argv.slice(2)
  const manual = readdirSync(ICLOUD).filter((f) => /^manual-.+\.json$/.test(f)).sort()
  return ['payments.json', ...manual].map((f) => `${ICLOUD}/${f}`).filter((f) => existsSync(f))
}

const text = files().map((f) => readFileSync(f, 'utf8')).join('\n')
for (const n of lib.reparseLines(text)) process.stdout.write(JSON.stringify(n) + '\n')
