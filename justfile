test:
  node --test

build: test
  python3 build.py

# First install only: opens the signed shortcut, Shortcuts asks to add it. Every import gets a
# new identifier, so the phone automation's Run Shortcut must be re-picked after it.
install: build
  open "build/Log Payment.shortcut"

# First install only of "Log Expense" (hand-typed payments; no automation points at it).
install-expense: build
  open "build/Log Expense.shortcut"

# Every later change: rewrites both installed shortcuts' actions in Shortcuts' database, keeping
# their identifiers (the automation stays bound), and waits for the iCloud uploads. One not
# installed yet is skipped.
update: test
  python3 build.py update

# The Mac's copy. The iCloud file is only ever appended to by the phone: rewriting it here could
# drop a line the phone appended meanwhile, or one iCloud had not brought over yet.
store := env_var('HOME') / ".local/share/expenses"

# Parse the phone's file again with the current parse.js into the Mac's copy.
reparse:
  mkdir -p "{{store}}"
  node reparse.mjs > "{{store}}/payments.json.new"
  mv "{{store}}/payments.json.new" "{{store}}/payments.json"
