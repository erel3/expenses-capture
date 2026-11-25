# expenses-capture — payment notifications into iCloud

The phone runs the shortcut "Log Payment" on every payment push. It appends one JSON line to
`payments.json` in iCloud Drive → Shortcuts (JSON Lines, despite the extension: Shortcuts forces
`.json` on JSON text): the push as received (`time`, `app`, `title`, `body`) plus, when
`parse.js` recognises a purchase or a refund, `amount` (negative for a refund), `currency`,
`kzt` (the amount in tenge, when known), `merchant`, `category`.

Two copies, one writer each:
- **iCloud `payments.json`** — the phone's. Only the shortcut writes it, and only by appending.
  Nothing on the Mac rewrites it: a rewrite could drop a line the phone appended meanwhile.
- **`~/.local/share/expenses/payments.json`** — the Mac's. `just reparse` rebuilds it from the
  iCloud file with the current `parse.js`, so a new parser or category also covers old pushes.
  A push repeated within a minute (every field but `time` the same) counts once: the automation
  sometimes runs twice for one push.

    duckdb -c "select * from read_json('~/.local/share/expenses/payments.json')"

- `parse.js` — every parser and the merchant → category map. It runs on the phone (pasted into the
  shortcut by `build.py`) and in node.
- `just test`, `just install` (first time only: opens the signed shortcut, Shortcuts asks to add
  it), `just update` (every later change), `just reparse`. Nothing on the Mac runs the shortcut
  with a push: it would append to the phone's file (see `just update` below).
- **`just update`** rewrites the installed shortcut's actions in Shortcuts' own database
  (`~/Library/Shortcuts/Shortcuts.sqlite`, backed up first to `~/.local/share/expenses/`, last 5
  kept), so its identifier stays and the automation needs no re-pick. Then it runs the shortcut
  with a marker input, which makes it append to `upload.json` instead: only a run that writes
  makes Shortcuts save the shortcut, and only its own save uploads it to iCloud. Never
  `payments.json`: iCloud keeps one device's version of a file, and a Mac probe line once
  vanished when the phone appended a push; the other way round it would have been the push.
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
