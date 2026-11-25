#!/usr/bin/env python3
"""Build and sign the "Log Payment" shortcut from parse.js.

The shortcut takes a notification as a dictionary {app, title, subtitle, body} (from a phone
automation; a JSON file works too, but nothing on the Mac may feed it one: see update()), runs parse.js
through WebKit and appends the result, one JSON line, to payments.json in iCloud Drive's
Shortcuts folder.

How JS runs inside Shortcuts (the trick the "Download" shortcut uses): an HTML page with the
script is URL-encoded into a data:text/html URL, and URL Decode is fed that URL coerced to
rich text, which makes WebKit render the page; the script leaves its answer, URL-encoded JSON,
as the page's text.

Action identifiers and parameter keys were read from the local Shortcuts database
(~/Library/Shortcuts/ToolKit/Tools-*.sqlite, table Parameters).
"""

import plistlib
import random
import sqlite3
import subprocess
import sys
import time
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "build"
NAME = "Log Payment"
# JSON Lines, but named .json: Shortcuts appends to "<path>.json" when the text is JSON and the
# path does not end in .json (raw.jsonl became raw.jsonl.json, a text coercion did not help).
FILE = "payments.json"
# What `update`'s run writes instead (see actions()), and the marker its input carries.
UPLOAD_FILE = "upload.json"
UPLOAD_MARK = "erel3-expenses-upload"
OBJ = "￼"  # where a variable sits inside a token string


def nsrange_start(s: str, index: int) -> int:
  """attachmentsByRange keys are NSRanges, counted in UTF-16 code units."""
  return len(s[:index].encode("utf-16-le")) // 2


def tokens(parts):
  """A text field mixing literal strings and variables (dicts)."""
  text, attachments = "", {}
  for p in parts:
    if isinstance(p, str):
      text += p
    else:
      attachments[f"{{{nsrange_start(text, len(text))}, 1}}"] = p
      text += OBJ
  return {"Value": {"string": text, "attachmentsByRange": attachments},
          "WFSerializationType": "WFTextTokenString"}


def output(uid, name, *aggrandizements):
  v = {"Type": "ActionOutput", "OutputUUID": uid, "OutputName": name}
  if aggrandizements:
    v["Aggrandizements"] = list(aggrandizements)
  return v


def coerce(item_class):
  return {"Type": "WFCoercionVariableAggrandizement", "CoercionItemClass": item_class}


def attachment(var):
  return {"Value": var, "WFSerializationType": "WFTextTokenAttachment"}


def action(identifier, **params):
  return {"WFWorkflowActionIdentifier": f"is.workflow.actions.{identifier}",
          "WFWorkflowActionParameters": params}


def stable(role: str) -> str:
  """A fixed action UUID. iOS keeps an "Always Allow" answer per action UUID
  (ZSMARTPROMPTPERMISSION.ZACTIONUUID), so a UUID that changed with every build asked again after
  each update, and an automation on a locked phone cannot answer: the push would be lost."""
  return str(uuid.uuid5(uuid.NAMESPACE_URL, f"erel3/expenses/{NAME}/{role}")).upper()


def actions(script: str):
  (page, url, result, group, append_id, end_id, in_group, in_end, given, probe, up_group,
   up_append, up_end) = (
    stable(r) for r in ("page", "url", "result", "group", "append", "end", "in-group", "in-end",
                        "given", "probe", "upload-group", "upload-append", "upload-end"))
  shortcut_input = {"Type": "ExtensionInput"}
  # A run with no input (a hand run on the phone) appends one probe line, {"time", "probe": true}:
  # it asks the write permission once while someone can answer it. It has to be chosen here, not
  # in the script: with no input Shortcuts drops the whole page text, so the script never runs.
  # A dictionary of empty fields (a hand run of the automation) writes nothing. reparse.mjs skips
  # probes.
  html = [
    '<html><head><meta charset="utf-8"></head><body/><script>let input=',
    output(in_end, "If Result"),  # the input as JSON text (dictionary or JSON file), or the probe
    ";\n" + script +
    "\nif (input.app || input.title || input.body || input.probe)"
    " document.body.textContent=encodeURIComponent(JSON.stringify(parse(input)))</script></html>",
  ]
  payment = output(result, "Payment")
  return [
    action("conditional", WFControlFlowMode=0, GroupingIdentifier=in_group, WFCondition=100,
           WFInput={"Type": "Variable", "Variable": attachment(shortcut_input)}),
    action("gettext", WFTextActionText=tokens([shortcut_input]), UUID=given),
    action("conditional", WFControlFlowMode=1, GroupingIdentifier=in_group),
    action("gettext", WFTextActionText='{"probe":true}', UUID=probe),
    action("conditional", WFControlFlowMode=2, GroupingIdentifier=in_group, UUID=in_end),
    # `update`'s run on the Mac: write UPLOAD_FILE, never payments.json. Only a run that writes
    # makes Shortcuts save (and so upload) the shortcut, but a line the Mac appends to
    # payments.json can cost one the phone appended meanwhile: iCloud keeps one device's version
    # of the file (a Mac probe line vanished when the phone appended a push, 2026-11-20).
    action("conditional", WFControlFlowMode=0, GroupingIdentifier=up_group, WFCondition=99,
           WFConditionalActionString=UPLOAD_MARK,
           WFInput={"Type": "Variable", "Variable": attachment(output(in_end, "If Result"))}),
    action("file.append", WFInput=tokens([output(in_end, "If Result")]),
           WFFilePath=tokens([UPLOAD_FILE]), WFAppendFileWriteMode="Append",
           WFAppendOnNewLine=True, UUID=up_append),
    action("conditional", WFControlFlowMode=1, GroupingIdentifier=up_group),
    action("urlencode", WFInput=tokens(html), WFEncodeMode="Encode",
           CustomOutputName="Page", UUID=page),
    action("url", WFURLActionURL=tokens(["data:text/html,", output(page, "Page")]),
           CustomOutputName="JavaScript", UUID=url),
    action("urlencode",
           WFInput=tokens([output(url, "JavaScript", coerce("WFRichTextContentItem"))]),
           WFEncodeMode="Decode", CustomOutputName="Payment", UUID=result),
    # "contains time", not "has any value": empty decoded text still counts as a value, so an
    # empty run created a 0-byte payments.json. Every line parse() writes has a time field.
    action("conditional", WFControlFlowMode=0, GroupingIdentifier=group, WFCondition=99,
           WFConditionalActionString="time",
           WFInput={"Type": "Variable", "Variable": attachment(payment)}),
    action("file.append", WFInput=tokens([payment]), WFFilePath=tokens([FILE]),
           WFAppendFileWriteMode="Append", WFAppendOnNewLine=True, UUID=append_id),
    action("conditional", WFControlFlowMode=2, GroupingIdentifier=group, UUID=end_id),
    action("conditional", WFControlFlowMode=2, GroupingIdentifier=up_group, UUID=up_end),
    # Output nothing. Otherwise Shortcuts appends an output action of its own on save, and each
    # caller is asked "Allow Log Payment to output 1 dictionary?" (a CLI run on the Mac hung on it).
    # No UUID on purpose: the run `update` makes gives it one and saves the shortcut, and only a
    # save by Shortcuts itself uploads it to iCloud. No permission is tied to this action.
    action("nothing"),
  ]


def main():
  script = (HERE / "parse.js").read_text()
  if "</script" in script:
    sys.exit("parse.js must not contain </script: it is pasted into an HTML page")
  shortcut = {
    "WFWorkflowActions": actions(script),
    "WFWorkflowClientVersion": "3218.0.9",
    "WFWorkflowMinimumClientVersion": 900,
    "WFWorkflowMinimumClientVersionString": "900",
    "WFWorkflowIcon": {"WFWorkflowIconStartColor": 4292093695, "WFWorkflowIconGlyphNumber": 59511},
    "WFWorkflowImportQuestions": [],
    "WFWorkflowInputContentItemClasses": ["WFDictionaryContentItem", "WFGenericFileContentItem",
                                          "WFStringContentItem"],
    "WFWorkflowHasShortcutInputVariables": True,
    "WFWorkflowTypes": [],
  }
  if sys.argv[1:] == ["update"]:
    update(shortcut["WFWorkflowActions"])
    return
  OUT.mkdir(exist_ok=True)
  unsigned = OUT / f"{NAME}.unsigned.shortcut"
  signed = OUT / f"{NAME}.shortcut"
  unsigned.write_bytes(plistlib.dumps(shortcut, fmt=plistlib.FMT_BINARY))
  subprocess.run(["shortcuts", "sign", "--mode", "anyone",
                  "--input", str(unsigned), "--output", str(signed)], check=True)
  print(signed)


DB = Path.home() / "Library/Shortcuts/Shortcuts.sqlite"
BACKUPS = Path.home() / ".local/share/expenses"
KEEP_BACKUPS = 5
APPLE_EPOCH = 978307200  # Core Data dates count from 2001-01-01


def update(new_actions):
  """Replace the actions of the installed "Log Payment" in Shortcuts' own database.

  Unlike an import, this keeps the shortcut's identifier, which the phone automation's
  Run Shortcut holds, so the automation needs no re-pick. Not an Apple interface: the database
  is Shortcuts' Core Data store. A fresh ZSYNCHASH that differs from ZLASTSYNCEDHASH is what
  made Shortcuts re-save the row and upload it to iCloud (verified 2026-11-20: the phone got the
  new script). The whole database is backed up first; restore = quit Shortcuts, copy it back.
  """
  BACKUPS.mkdir(parents=True, exist_ok=True)
  backup = BACKUPS / f"shortcuts-backup-{time.strftime('%Y%m%d-%H%M%S')}.sqlite"
  with sqlite3.connect(DB, timeout=10) as db:
    rows = db.execute("select Z_PK from ZSHORTCUT where ZNAME = ? and ZTOMBSTONED = 0",
                      (NAME,)).fetchall()
    if len(rows) != 1:
      sys.exit(f'{len(rows)} shortcuts named "{NAME}" (need exactly one): '
               "install it once with `just install`, or delete the extra copies")
    pk = rows[0][0]
    with sqlite3.connect(backup) as out:
      db.backup(out)
    db.execute("update ZSHORTCUTACTIONS set ZDATA = ?, Z_OPT = Z_OPT + 1 where ZSHORTCUT = ?",
               (plistlib.dumps(new_actions, fmt=plistlib.FMT_BINARY), pk))
    db.execute("update ZSHORTCUT set ZMODIFICATIONDATE = ?, Z_OPT = Z_OPT + 1, ZSYNCHASH = ?, "
               "ZACTIONCOUNT = ? where Z_PK = ?",
               (time.time() - APPLE_EPOCH, random.randint(-2**63, 2**63 - 1), len(new_actions), pk))
  for old in sorted(BACKUPS.glob("shortcuts-backup-*.sqlite"))[:-KEEP_BACKUPS]:
    old.unlink()
  print(f'updated "{NAME}" in place; backup {backup}')
  # Shortcuts uploads a row only after it saves it itself, and only a run that writes a file
  # makes it save (a run that wrote nothing did not, measured 2026-11-20). This run carries
  # UPLOAD_MARK, so it appends to UPLOAD_FILE and never touches payments.json (see actions()).
  # A run once hung for 60 s on a Mac permission prompt; the upload check below still decides.
  OUT.mkdir(exist_ok=True)
  mark = OUT / "upload.json"
  mark.write_text(f'{{"{UPLOAD_MARK}": "{time.strftime("%Y-%m-%dT%H:%M:%S%z")}"}}\n')
  try:
    subprocess.run(["shortcuts", "run", NAME, "--input-path", str(mark)], check=True, timeout=60)
  except subprocess.TimeoutExpired:
    print("the empty run timed out; checking the upload anyway")
  for _ in range(30):
    with sqlite3.connect(f"file:{DB}?mode=ro", uri=True) as db:
      synced, last = db.execute("select ZSYNCHASH, ZLASTSYNCEDHASH from ZSHORTCUT where Z_PK = ?",
                                (pk,)).fetchone()
    if synced == last:
      print("uploaded to iCloud")
      return
    time.sleep(1)
  sys.exit("not uploaded to iCloud within 30 s: check the phone before relying on it")


if __name__ == "__main__":
  main()
