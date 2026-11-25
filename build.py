#!/usr/bin/env python3
"""Build and sign the two shortcuts from parse.js.

"Log Payment" takes a notification as a dictionary {app, title, subtitle, body} (from a phone
automation; a JSON file works too, but nothing on the Mac may feed it one: see update()), runs
parse.js through WebKit and appends the result, one JSON line, to payments.json in iCloud Drive's
Shortcuts folder.

"Log Expense" asks for an amount, what it was and a category, and appends the same kind of line to
manual-<device model>.json: a payment that sent no push (cash, a transfer). One file per device, so
every file in the folder has one writer and iCloud never has to pick one device's copy.

How JS runs inside Shortcuts (the trick the "Download" shortcut uses): an HTML page with the
script is URL-encoded into a data:text/html URL, and URL Decode is fed that URL coerced to
rich text, which makes WebKit render the page; the script leaves its answer, URL-encoded JSON,
as the page's text.

Action identifiers and parameter keys were read from the local Shortcuts database
(~/Library/Shortcuts/ToolKit/Tools-*.sqlite, table Parameters); the Dictionary action's shape
from the owner's "Download" shortcut.

  python3 build.py           build and sign both into build/
  python3 build.py update    rewrite the installed ones in place (see update())
"""

import json
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
PAYMENT = "Log Payment"
EXPENSE = "Log Expense"
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


def stable(name: str, role: str) -> str:
  """A fixed action UUID. iOS keeps an "Always Allow" answer per action UUID
  (ZSMARTPROMPTPERMISSION.ZACTIONUUID), so a UUID that changed with every build asked again after
  each update, and an automation on a locked phone cannot answer: the push would be lost. Never
  change the namespace string: Log Payment's permissions hang on it."""
  return str(uuid.uuid5(uuid.NAMESPACE_URL, f"erel3/expenses/{name}/{role}")).upper()


def text_item(key, value, item_type=0):
  """One row of a Dictionary action. Types: 0 text, 3 number."""
  return {"WFItemType": item_type, "WFKey": tokens([key]), "WFValue": tokens(value)}


def run_parse(name, script, input_var, result_name):
  """The WebKit block: parse.js's parse() over `input_var` (the push as JSON text). Its last action
  outputs the parsed line as text, named `result_name`."""
  page, url, result = (stable(name, r) for r in ("page", "url", "result"))
  html = [
    '<html><head><meta charset="utf-8"></head><body/><script>let input=',
    input_var,
    ";\n" + script +
    "\nif (input.app || input.title || input.body || input.probe)"
    " document.body.textContent=encodeURIComponent(JSON.stringify(parse(input)))</script></html>",
  ]
  return [
    action("urlencode", WFInput=tokens(html), WFEncodeMode="Encode",
           CustomOutputName="Page", UUID=page),
    action("url", WFURLActionURL=tokens(["data:text/html,", output(page, "Page")]),
           CustomOutputName="JavaScript", UUID=url),
    action("urlencode",
           WFInput=tokens([output(url, "JavaScript", coerce("WFRichTextContentItem"))]),
           WFEncodeMode="Decode", CustomOutputName=result_name, UUID=result),
  ], output(result, result_name)


def upload_branch(name, input_var):
  """`update`'s run on the Mac: write UPLOAD_FILE, never a data file. Only a run that writes makes
  Shortcuts save (and so upload) the shortcut, but a line the Mac appends to payments.json can cost
  one the phone appended meanwhile: iCloud keeps one device's version of the file (a Mac probe
  line vanished when the phone appended a push, 2026-11-20). Returns (If…Otherwise actions, End If)."""
  group, append_id, end = (stable(name, r) for r in ("upload-group", "upload-append", "upload-end"))
  return [
    action("conditional", WFControlFlowMode=0, GroupingIdentifier=group, WFCondition=99,
           WFConditionalActionString=UPLOAD_MARK,
           WFInput={"Type": "Variable", "Variable": attachment(input_var)}),
    action("file.append", WFInput=tokens([input_var]),
           WFFilePath=tokens([UPLOAD_FILE]), WFAppendFileWriteMode="Append",
           WFAppendOnNewLine=True, UUID=append_id),
    action("conditional", WFControlFlowMode=1, GroupingIdentifier=group),
  ], action("conditional", WFControlFlowMode=2, GroupingIdentifier=group, UUID=end)


def append_if_parsed(name, line, path_parts):
  """Append `line` to the file only when it is a parsed line: "contains time", not "has any value":
  empty decoded text still counts as a value, so an empty run created a 0-byte payments.json.
  Every line parse() writes has a time field. Returns (If + append actions, End If)."""
  group, append_id, end = (stable(name, r) for r in ("group", "append", "end"))
  return [
    action("conditional", WFControlFlowMode=0, GroupingIdentifier=group, WFCondition=99,
           WFConditionalActionString="time",
           WFInput={"Type": "Variable", "Variable": attachment(line)}),
    action("file.append", WFInput=tokens([line]), WFFilePath=tokens(path_parts),
           WFAppendFileWriteMode="Append", WFAppendOnNewLine=True, UUID=append_id),
  ], action("conditional", WFControlFlowMode=2, GroupingIdentifier=group, UUID=end)


def refresh_app(name, device_var):
  """The Expenses iPhone app's "Refresh Expenses" (an App Intent, run in the background) after a line
  was written, so the iPhone widget shows it seconds later. iPhone only: the Mac app is built
  without App Intents metadata and watches the files itself. The action's shape was read from a
  shortcut the owner made with it (2026-11-25), not guessed."""
  group, refresh, end = (stable(name, r) for r in ("refresh-group", "refresh", "refresh-end"))
  return [
    action("conditional", WFControlFlowMode=0, GroupingIdentifier=group, WFCondition=99,
           WFConditionalActionString="iPhone",
           WFInput={"Type": "Variable", "Variable": attachment(device_var)}),
    {"WFWorkflowActionIdentifier": "com.akim.expenses.RefreshExpensesIntent",
     "WFWorkflowActionParameters": {"UUID": refresh, "AppIntentDescriptor": {
       "TeamIdentifier": "73R36N2A46", "BundleIdentifier": "com.akim.expenses", "Name": "Expenses",
       "AppIntentIdentifier": "RefreshExpensesIntent"}}},
    action("conditional", WFControlFlowMode=2, GroupingIdentifier=group, UUID=end),
  ]


# Output nothing. Otherwise Shortcuts appends an output action of its own on save, and each
# caller is asked "Allow Log Payment to output 1 dictionary?" (a CLI run on the Mac hung on it).
# No UUID on purpose: the run `update` makes gives it one and saves the shortcut, and only a
# save by Shortcuts itself uploads it to iCloud. No permission is tied to this action.
NOTHING = action("nothing")


def payment_actions(script: str):
  name = PAYMENT
  in_group, in_end, given, probe = (stable(name, r) for r in ("in-group", "in-end", "given", "probe"))
  shortcut_input = {"Type": "ExtensionInput"}
  # A run with no input (a hand run on the phone) appends one probe line, {"time", "probe": true}:
  # it asks the write permission once while someone can answer it. It has to be chosen here, not
  # in the script: with no input Shortcuts drops the whole page text, so the script never runs.
  # A dictionary of empty fields (a hand run of the automation) writes nothing. reparse.mjs skips
  # probes.
  received = output(in_end, "If Result")  # the input as JSON text (dictionary or JSON file), or the probe
  upload, upload_end = upload_branch(name, received)
  parse_block, payment = run_parse(name, script, received, "Payment")
  append, append_end = append_if_parsed(name, payment, [FILE])
  return [
    action("conditional", WFControlFlowMode=0, GroupingIdentifier=in_group, WFCondition=100,
           WFInput={"Type": "Variable", "Variable": attachment(shortcut_input)}),
    action("gettext", WFTextActionText=tokens([shortcut_input]), UUID=given),
    action("conditional", WFControlFlowMode=1, GroupingIdentifier=in_group),
    action("gettext", WFTextActionText='{"probe":true}', UUID=probe),
    action("conditional", WFControlFlowMode=2, GroupingIdentifier=in_group, UUID=in_end),
    *upload, *parse_block, *append,
    action("getdevicedetails", WFDeviceDetail="Device Model", CustomOutputName="Device",
           UUID=stable(name, "device")),
    *refresh_app(name, output(stable(name, "device"), "Device")),
    append_end, upload_end, NOTHING,
  ]


def expense_actions(script: str, categories: list[str]):
  name = EXPENSE
  amount, what, items, picked, device, fields, given, received = (
    stable(name, r) for r in ("amount", "what", "categories", "picked", "device", "fields", "given", "received"))
  shortcut_input = {"Type": "ExtensionInput"}
  # "Contains" on the raw input file never matched the marker, so `update`'s run fell through to
  # the questions and failed ("Please choose a value for each parameter"): compare its text.
  received_var = output(received, "Received")
  upload, upload_end = upload_branch(name, received_var)
  amount_var, what_var = output(amount, "Amount"), output(what, "What")
  picked_var, device_var = output(picked, "Category"), output(device, "Device")
  parse_block, line = run_parse(name, script, output(given, "Expense"), "Expense line")
  # One file per device: payments.json is the phone automation's, manual-Mac.json the Mac's own.
  append, append_end = append_if_parsed(name, line, ["manual-", device_var, ".json"])
  return [
    action("gettext", WFTextActionText=tokens([shortcut_input]), CustomOutputName="Received", UUID=received),
    *upload,
    action("ask", WFInputType="Number", WFAskActionPrompt="Amount, ₸",
           WFAskActionAllowsDecimalNumbers=True, WFAskActionAllowsNegativeNumbers=True,
           CustomOutputName="Amount", UUID=amount),
    action("ask", WFInputType="Text", WFAskActionPrompt="What was it?",
           CustomOutputName="What", UUID=what),
    action("list", WFItems=[{"WFItemType": 0, "WFValue": tokens([c])} for c in categories],
           UUID=items),
    # The list as a plain attachment, as Shortcuts stores it itself: wrapped as {"Type": "Variable"}
    # (the If action's form) it read as empty, the question was skipped and the category came out "".
    action("choosefromlist", WFInput=attachment(output(items, "List")),
           WFChooseFromListActionPrompt="Category", CustomOutputName="Category", UUID=picked),
    action("getdevicedetails", WFDeviceDetail="Device Model", CustomOutputName="Device", UUID=device),
    # The same shape the phone automation sends, so parse.js's Manual parser reads it; the amount
    # as a number (type 3) so it reaches the script as 1500.5 whatever the locale prints.
    action("dictionary", WFItems={"Value": {"WFDictionaryFieldValueItems": [
      text_item("app", ["Manual"]), text_item("title", [what_var]), text_item("subtitle", [picked_var]),
      text_item("body", [amount_var], item_type=3),
    ]}, "WFSerializationType": "WFDictionaryFieldValue"}, CustomOutputName="Fields", UUID=fields),
    action("gettext", WFTextActionText=tokens([output(fields, "Fields")]), CustomOutputName="Expense", UUID=given),
    *parse_block, *append,
    action("notification", WFNotificationActionTitle="Expense logged",
           WFNotificationActionBody=tokens([amount_var, " ₸ · ", what_var, " · ", picked_var]),
           WFNotificationActionSound=False),
    *refresh_app(name, device_var),
    append_end, upload_end, NOTHING,
  ]


def categories() -> list[str]:
  """The categories parse.js knows, in table order, then "other": the Log Expense menu."""
  out = subprocess.run(["node", "-e", "const c = require('./parse.js').CATEGORIES;"
                        "console.log(JSON.stringify([...new Set(Object.values(c))]))"],
                       cwd=HERE, check=True, capture_output=True, text=True).stdout
  return [*json.loads(out), "other"]


def shortcut(actions, icon_color):
  return {
    "WFWorkflowActions": actions,
    "WFWorkflowClientVersion": "3218.0.9",
    "WFWorkflowMinimumClientVersion": 900,
    "WFWorkflowMinimumClientVersionString": "900",
    "WFWorkflowIcon": {"WFWorkflowIconStartColor": icon_color, "WFWorkflowIconGlyphNumber": 59511},
    "WFWorkflowImportQuestions": [],
    "WFWorkflowInputContentItemClasses": ["WFDictionaryContentItem", "WFGenericFileContentItem",
                                          "WFStringContentItem"],
    "WFWorkflowHasShortcutInputVariables": True,
    "WFWorkflowTypes": [],
  }


def main():
  script = (HERE / "parse.js").read_text()
  if "</script" in script:
    sys.exit("parse.js must not contain </script: it is pasted into an HTML page")
  shortcuts = {
    PAYMENT: shortcut(payment_actions(script), 4292093695),
    EXPENSE: shortcut(expense_actions(script, categories()), 4282601983),
  }
  if sys.argv[1:] == ["update"]:
    for name, plist in shortcuts.items():
      update(name, plist["WFWorkflowActions"])
    return
  OUT.mkdir(exist_ok=True)
  for name, plist in shortcuts.items():
    unsigned = OUT / f"{name}.unsigned.shortcut"
    signed = OUT / f"{name}.shortcut"
    unsigned.write_bytes(plistlib.dumps(plist, fmt=plistlib.FMT_BINARY))
    subprocess.run(["shortcuts", "sign", "--mode", "anyone",
                    "--input", str(unsigned), "--output", str(signed)], check=True)
    print(signed)


DB = Path.home() / "Library/Shortcuts/Shortcuts.sqlite"
BACKUPS = Path.home() / ".local/share/expenses"
KEEP_BACKUPS = 5
APPLE_EPOCH = 978307200  # Core Data dates count from 2001-01-01


def update(name, new_actions):
  """Replace the actions of an installed shortcut in Shortcuts' own database.

  Unlike an import, this keeps the shortcut's identifier, which the phone automation's
  Run Shortcut holds, so the automation needs no re-pick. Not an Apple interface: the database
  is Shortcuts' Core Data store. A fresh ZSYNCHASH that differs from ZLASTSYNCEDHASH is what
  made Shortcuts re-save the row and upload it to iCloud (verified 2026-11-20: the phone got the
  new script). The whole database is backed up first; restore = quit Shortcuts, copy it back.
  """
  BACKUPS.mkdir(parents=True, exist_ok=True)
  # The name too: both shortcuts are updated within the same second, and one backup overwrote the other.
  backup = BACKUPS / f"shortcuts-backup-{time.strftime('%Y%m%d-%H%M%S')}-{name.replace(' ', '-')}.sqlite"
  with sqlite3.connect(DB, timeout=10) as db:
    rows = db.execute("select Z_PK from ZSHORTCUT where ZNAME = ? and ZTOMBSTONED = 0",
                      (name,)).fetchall()
    if not rows:
      recipe = "install" if name == PAYMENT else "install-expense"
      print(f'"{name}" is not installed yet: `just {recipe}` adds it once; skipped')
      return
    if len(rows) > 1:
      sys.exit(f'{len(rows)} shortcuts named "{name}" (need exactly one): delete the extra copies')
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
  print(f'updated "{name}" in place; backup {backup}')
  # Shortcuts uploads a row only after it saves it itself, and only a run that writes a file
  # makes it save (a run that wrote nothing did not, measured 2026-11-20). This run carries
  # UPLOAD_MARK, so it appends to UPLOAD_FILE and never touches payments.json (see actions()).
  # A run once hung for 60 s on a Mac permission prompt; the upload check below still decides.
  OUT.mkdir(exist_ok=True)
  mark = OUT / "upload.json"
  mark.write_text(f'{{"{UPLOAD_MARK}": "{time.strftime("%Y-%m-%dT%H:%M:%S%z")}"}}\n')
  try:
    subprocess.run(["shortcuts", "run", name, "--input-path", str(mark)], check=True, timeout=60)
  except subprocess.TimeoutExpired:
    print("the empty run timed out; checking the upload anyway")
  for _ in range(30):
    with sqlite3.connect(f"file:{DB}?mode=ro", uri=True) as db:
      synced, last = db.execute("select ZSYNCHASH, ZLASTSYNCEDHASH from ZSHORTCUT where Z_PK = ?",
                                (pk,)).fetchone()
    if synced == last:
      print(f'"{name}" uploaded to iCloud')
      return
    time.sleep(1)
  sys.exit(f'"{name}" not uploaded to iCloud within 30 s: check the phone before relying on it')


if __name__ == "__main__":
  main()
