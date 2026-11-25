// Parse every line of the phone's payments.json again with the current parse.js: run after
// adding a parser, a category or fixing a regex. Prints the result; the input is never written
// (`just reparse` puts it in ~/.local/share/expenses/). The received fields pass through as is;
// probes and repeated pushes are dropped (parse.js reparseLines, shared with the Expenses app).
//   node reparse.mjs [payments.json] > out.json
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import lib from './parse.js'

const ICLOUD = `${homedir()}/Library/Mobile Documents/iCloud~is~workflow~my~workflows/Documents`
const path = process.argv[2] ?? `${ICLOUD}/payments.json`

for (const n of lib.reparseLines(readFileSync(path, 'utf8'))) {
  process.stdout.write(JSON.stringify(n) + '\n')
}
