// Parse every line of the phone's payments.json again with the current parse.js: run after
// adding a parser, a category or fixing a regex. Prints the result; the input is never written
// (`just reparse` puts it in ~/.local/share/expenses/). The received fields pass through as is.
//   node reparse.mjs [payments.json] > out.json
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import lib from './parse.js'

const ICLOUD = `${homedir()}/Library/Mobile Documents/iCloud~is~workflow~my~workflows/Documents`

// The automation sometimes runs twice for one push: on 2026-11-23 a Freedom debit and its cashback
// each landed twice, a second apart, every field the same but `time` (the shortcut stamps it), the
// balance in the body included, while the bank app showed one payment. A real second payment
// changes the balance the body prints, so the same app, title, subtitle and body within a minute
// is the same push.
const SAME_PUSH_MS = 60_000

// Lines of payments.json -> parsed pushes, without probes and repeated pushes.
export function reparse(lines) {
  const seen = new Map() // push without time -> when it was last seen, in ms
  const out = []
  for (const line of lines) {
    if (!line.trim()) continue
    const n = JSON.parse(line)
    // A hand run of the shortcut on the phone appends one probe line (it asks the write permission
    // once); it is no payment.
    if (n.probe) continue
    const key = JSON.stringify([n.app, n.title, n.subtitle, n.body])
    const at = Date.parse(n.time)
    const before = seen.get(key)
    seen.set(key, at)
    if (before !== undefined && at - before < SAME_PUSH_MS) continue
    out.push(lib.parse(n))
  }
  return out
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2] ?? `${ICLOUD}/payments.json`
  for (const n of reparse(readFileSync(path, 'utf8').split('\n'))) {
    process.stdout.write(JSON.stringify(n) + '\n')
  }
}
