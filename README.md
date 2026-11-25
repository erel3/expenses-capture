# expenses-capture — payment notifications into iCloud

Everything lives in **iCloud Drive → Shortcuts → Expenses**, as JSON Lines (one JSON object per
line; named `.json` because Shortcuts forces that extension on JSON text):

| File | Written by | Holds |
|---|---|---|
| `<device>-<year>.json` (`iPhone-2026.json`, `Mac-2026.json`) | that device's shortcuts | every line it captured that year |
| `edits-<device>.json` | that device's Expenses app | corrections: a category (for one payment or every payment of a merchant), an amount, hide/unhide |
| `archive-2026.json` | `archive.py`, once | the lines of the old layout (Shortcuts/payments.json, manual-iPhone.json, until 2026-11-25) |
| `upload.json` | `just update` | a technical line, never read as data |

Every file has one writer and is only ever appended to: iCloud keeps one device's version of a
file two devices write, and a line once vanished that way. A past year never changes again, so the
current file stays small (~1 MB a year).

- **"Log Payment"** runs on every push of Kaspi, Freedom and Halyk (the phone automation) and
  appends the push as received (`time`, `app`, `title`, `subtitle`, `body`) plus, when `parse.js`
  recognises a purchase or a refund, `amount` (negative for a refund), `currency`, `kzt`,
  `merchant`, `category`.
- **"Log Expense"** (iPhone or Mac) asks for an amount, what it was and a category, for payments
  that send no push (cash, a transfer to a person). `just install-expense` adds it once.
- **Readers** (the Expenses apps, `just reparse`) read every data file together through parse.js
  `reparseLines`, which drops probes and repeated pushes, gives each push a stable `id` and applies
  the corrections. Nothing captured is ever rewritten or deleted; hiding is the undoable delete.
- `just reparse` writes the Mac's copy, `~/.local/share/expenses/payments.json`:

    duckdb -c "select * from read_json('~/.local/share/expenses/payments.json', union_by_name=true)"

- `parse.js` — every parser and the merchant → category map. It runs on the phone (pasted into the
  shortcut by `build.py`) and in node.
- `just test`, `just install` (first time only: opens the signed shortcut, Shortcuts asks to add
  it), `just update` (every later change), `just reparse`.
- **`just update`** rewrites the installed shortcut's actions in Shortcuts' own database
  (`~/Library/Shortcuts/Shortcuts.sqlite`, backed up first to `~/.local/share/expenses/`, last 5
  kept), so its identifier stays and the automation needs no re-pick. Then it runs the shortcut
  with a marker input, which makes it append to `upload.json` instead: only a run that writes
  makes Shortcuts save the shortcut, and only its own save uploads it to iCloud. Never
  a data file: the Mac may write only its own `Mac-<year>.json`, and the update's run is no
  payment.
- **Run "Log Payment" by hand on the iPhone once after each change of action UUIDs** (they are
  fixed in `build.py`, so normally never): it writes a probe and asks to allow the write; answer
  Always Allow. iOS keeps that answer per action UUID, and a locked phone cannot answer it, so
  an unanswered prompt would cost a real push.

## Automation (one per app)

Automations sync through iCloud (iOS 27) but are enabled per device. Run Shortcut points at
"Log Payment" by its identifier: `just update` keeps it, an import (`just install`, Replace
included) makes a new one, and the automation must then pick "Log Payment" again.

1. Shortcuts → Automation → New → Notification → App: Kaspi.kz, Freedom, Halyk (every push of
   the three is kept; parsers exist for Kaspi Gold purchases and Freedom debits, Halyk is captured
   until its format is known) → Run Immediately.
2. Action Dictionary: `app`, `title`, `subtitle`, `body` each set to the matching field of the
   notification. Any other key is kept as well.
3. Action Run Shortcut → "Log Payment", input: the Dictionary.
