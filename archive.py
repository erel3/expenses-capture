#!/usr/bin/env python3
"""Move the old layout's lines into the Expenses folder, once.

Before 2026-11-25 the shortcuts wrote Shortcuts/payments.json (the phone's pushes) and
Shortcuts/manual-<device>.json (Log Expense). Now every line goes to Shortcuts/Expenses/
<device>-<year>.json. This copies the old lines, byte for byte, into Expenses/archive-<year>.json
(by each line's own year) and checks that parse.js reads exactly the same payments from the copy
as from the originals. The originals are left untouched; `--trash` moves them to the Trash
afterwards (and is refused while the copy and the originals differ).

  python3 archive.py            copy + check
  python3 archive.py --trash    then move the old files to the Trash

Safe to run only once the phone writes the new layout (its Expenses/iPhone-<year>.json exists):
otherwise a push could still land in payments.json after it was copied. archive-*.json is written
by this script alone and never again, so it has one writer like every other file.
"""

import json
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SHORTCUTS = Path.home() / "Library/Mobile Documents/iCloud~is~workflow~my~workflows/Documents"
FOLDER = SHORTCUTS / "Expenses"


def old_files() -> list[Path]:
  return sorted(p for p in SHORTCUTS.iterdir()
                if p.name == "payments.json" or (p.name.startswith("manual-") and p.suffix == ".json"))


def parsed(paths: list[Path]) -> list[str]:
  """What `just reparse` makes of these files: one JSON line per push, ids included."""
  out = subprocess.run(["node", "reparse.mjs", *map(str, paths)], cwd=HERE, check=True,
                       capture_output=True, text=True).stdout
  return out.splitlines()


def main() -> None:
  old = old_files()
  archives = sorted(FOLDER.glob("archive-*.json"))
  if "--trash" in sys.argv[1:]:
    if not archives:
      sys.exit("no archive yet: run `python3 archive.py` first")
    if not old:
      sys.exit("nothing left to move: the old files are gone already")
    if parsed(old) != parsed(archives):
      sys.exit("the archive and the old files differ: nothing moved")
    trash = Path.home() / ".Trash"
    for path in old:
      target = trash / f"{path.stem} (expenses old layout){path.suffix}"
      shutil.move(str(path), target)
      print(f"moved {path.name} to {target}")
    return
  if archives:
    sys.exit(f"{archives[0].name} exists already: the archive is written once")
  if not old:
    sys.exit("no old files to archive")
  if not list(FOLDER.glob("iPhone-*.json")):
    sys.exit("the iPhone does not write Expenses/iPhone-<year>.json yet: run Log Payment once by hand "
             "on the phone (after its shortcuts synced), then again")
  by_year: dict[str, list[str]] = {}
  for path in old:
    for line in path.read_text(encoding="utf-8").splitlines():
      if not line.strip():
        continue
      try:
        year = str(json.loads(line).get("time", ""))[:4]
      except json.JSONDecodeError:
        year = ""
      by_year.setdefault(year if year.isdigit() else "unknown", []).append(line)
  written = []
  for year, lines in sorted(by_year.items()):
    target = FOLDER / f"archive-{year}.json"
    target.write_text("\n".join(lines) + "\n", encoding="utf-8")
    written.append(target)
    print(f"{target.name}: {len(lines)} lines")
  if parsed(old) != parsed(written):
    for target in written:
      target.unlink()
    sys.exit("the copy reads differently from the originals: removed it, originals untouched")
  print(f"checked: {len(parsed(written))} pushes read the same from the archive; originals untouched")
  print("move them to the Trash with `python3 archive.py --trash` (asked before, by Claude)")


if __name__ == "__main__":
  main()
