// One payment notification in, one line of payments.json out: the notification as received
// (time, app, title, body) plus, when a parser knows the push, amount, currency, merchant and
// category. The parsed fields are derived: reparse.mjs rewrites them from the received ones.
// This file runs in two places: inside the "Log Payment" shortcut, where build.py pastes it into
// an HTML page that WebKit renders (so: plain browser JS, no imports, never the text of a
// closing script tag), and in node for the tests and reparse.mjs.

// Merchant (as the bank prints it, upper case) -> category. A key matches the merchant itself or
// its start, so 'YANDEX' would also catch 'YANDEX.GO'. Unknown merchants get an empty category.
const CATEGORIES = {
  'YANDEX.GO': 'transport',
  'YANDEX.EDA': 'food',
  'YANDEX.LAVKA': 'food',
  MAGNUM: 'food',
  SMALL: 'food',
  GLOVO: 'food',
  WOLT: 'food',
  ARBUZ: 'food',
  RYADOM: 'food',
  'ABR ': 'food', // ABR restaurants: "ABR LuckeeYu ..."
  'JETPAY*DRINKIT': 'food',
  'APPLE.COM/BILL': 'subscriptions',
  ANTHROPIC: 'subscriptions',
  FACEIT: 'subscriptions',
  LINKEDIN: 'subscriptions', // "LinkedIn P0000000000": a new invoice number every charge
}

// "3 080" or "100 000,00" (spaces may be NBSP / narrow NBSP) -> 3080, 100000
function number(s) {
  return Number(s.replace(/\s/g, '').replace(',', '.'))
}

function category(merchant) {
  const m = merchant.toUpperCase()
  const key = Object.keys(CATEGORIES).find((k) => m === k || m.startsWith(k))
  return key ? CATEGORIES[key] : ''
}

// Each parser returns {amount, currency, merchant} for a purchase or a refund, or null for any
// other push (transfers, top-ups, cashback, ads): those are kept as received, with no parsed
// fields. amount is what the payment cost: positive for a purchase, negative for a refund, so a
// sum of amounts in one currency is what was spent. kzt is the amount in tenge: the amount
// itself for a tenge payment, the bank's own conversion when it prints one, absent otherwise;
// sum(kzt) is what was spent across currencies.
const PARSERS = [
  {
    // Kaspi Gold: "Покупка: 3 080 ₸\nYANDEX.GO\nДоступно: 100 000,00 ₸", a refund
    // "Отмена покупки: 204,50 ₸\nWOLT.COM\nДоступно: …", a foreign one
    // "Покупка: 95,88 $ (43 674,30 ₸)\nFACEIT\nДоступно: …" (tenge in brackets).
    match: (n) => /kaspi/i.test(n.app) || /kaspi/i.test(n.title),
    parse(n) {
      const m = n.body.match(
        /(Покупка|Отмена покупки):\s*([\d\s]+(?:,\d+)?)\s*(\S+)(?:\s*\(([\d\s]+(?:,\d+)?)\s*₸\))?/,
      )
      if (!m) return null
      const sign = m[1] === 'Покупка' ? 1 : -1
      const merchant = (n.body.split(/\r?\n/)[1] || '').trim()
      const hit = { amount: sign * number(m[2]), currency: m[3], merchant }
      return m[4] ? { ...hit, kzt: sign * number(m[4]) } : hit
    },
  },
  {
    // Freedom: title "Списана сумма за заказ Arbuz.kz", body "-16 586 ₸\nДоступно 1 000,00 ₸\n
    // Списано с Deposit Card **0000". A debit starts the body with a minus. A refund is titled
    // "Возврат денег за заказ Arbuz.kz" with "+588 ₸"; cashback ("Кешбэк за покупку", "+1 658,6 ₸")
    // is a plus too, so a plus counts only under a "Возврат" title. The merchant is what follows
    // "за [заказ]" in the title, empty when the title has no such part.
    match: (n) => /freedom/i.test(n.app),
    parse(n) {
      const m = n.body.match(/^\s*([-−+])\s*([\d\s]+(?:,\d+)?)\s*(\S+)/)
      if (!m) return null
      const refund = m[1] === '+'
      if (refund && !/^\s*Возврат/.test(n.title)) return null
      // (?:^|\s), not \b: JS word boundaries are ASCII only and never match before "за".
      const merchant = ((n.title.match(/(?:^|\s)за\s+(?:заказ\s+)?(.+)$/) || [])[1] || '').trim()
      return { amount: (refund ? -1 : 1) * number(m[2]), currency: m[3], merchant }
    },
  },
  {
    // A payment typed in by hand with the "Log Expense" shortcut (cash, transfers, anything that
    // sends no push): title = what it was, subtitle = the category picked, body = the amount in
    // tenge as Shortcuts wrote the number ("1500", "1 500,5", "-1500" for a correction). The
    // picked category wins over the merchant table; "other" means none.
    match: (n) => n.app === 'Manual',
    parse(n) {
      const amount = number(n.body.replace(/[−–]/g, '-'))
      if (!n.body.trim() || !Number.isFinite(amount)) return null
      const picked = n.subtitle && n.subtitle !== 'other' ? String(n.subtitle) : ''
      return { amount, currency: '₸', merchant: n.title.trim(), ...(picked ? { category: picked } : {}) }
    },
  },
]

// Local time with its offset, e.g. 2026-11-19T19:23:05+05:00
function localIso(d) {
  const p = (x) => String(x).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const a = Math.abs(off)
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${off < 0 ? '-' : '+'}${p(Math.floor(a / 60))}:${p(a % 60)}`
  )
}

// n: what the automation sent ({app, title, subtitle, body}, any other field kept as is), plus
// time and old parsed fields when re-parsing. time is kept when present, stamped otherwise; old
// parsed fields are dropped and computed again.
function parse(n, now = new Date()) {
  const received = { ...n }
  for (const k of ['time', 'amount', 'kzt', 'currency', 'merchant', 'category', 'error', 'id', 'hidden', 'edited']) {
    delete received[k]
  }
  const note = {
    time: n.time || localIso(now),
    ...received,
    app: String(n.app || ''),
    title: String(n.title || ''),
    body: String(n.body || ''),
  }
  // Capturing every push matters more than parsing it: a parser that throws on a format nobody
  // has seen yet must not cost the line, so the push is kept with the error instead.
  try {
    const parser = PARSERS.find((p) => p.match(note))
    const hit = parser ? parser.parse(note) : null
    if (!hit) return note
    const kzt = hit.kzt ?? (hit.currency === '₸' ? hit.amount : undefined)
    return {
      ...note,
      ...hit,
      ...(kzt === undefined ? {} : { kzt }),
      // A parser's own category (a manual entry's pick) wins over the merchant table.
      category: hit.category || category(hit.merchant),
    }
  } catch (e) {
    return { ...note, error: String(e) }
  }
}

// The automation sometimes runs twice for one push: on 2026-11-23 a Freedom debit and its cashback
// each landed twice, a second apart, every field the same but `time` (the shortcut stamps it), the
// balance in the body included, while the bank app showed one payment. A real second payment
// changes the balance the body prints, so the same app, title, subtitle and body within a minute
// is the same push.
const SAME_PUSH_MS = 60000

// A push's id: a hash of what was received, so it never changes and corrections can point at it.
// FNV-1a, twice with different seeds, 16 hex digits.
function pushId(n) {
  const text = [n.time, n.app, n.title, n.body].map((v) => String(v ?? '')).join('|')
  const fnv = (seed) => {
    let h = seed >>> 0
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0
    return h.toString(16).padStart(8, '0')
  }
  return fnv(2166136261) + fnv(0x811c9dc5 ^ 0x5bd1e995)
}

// Corrections the apps write (edits-<device>.json), oldest first; the last one wins per target.
//   {"time", "edit": "category", "id" | "merchant", "value"}   this payment / every payment of a merchant
//   {"time", "edit": "amount", "id", "value"}                  its tenge
//   {"time", "edit": "hide" | "unhide", "id"}
// A payment's own category beats its merchant's, which beats the CATEGORIES table.
function readEdits(text) {
  const edits = { category: new Map(), merchant: new Map(), amount: new Map(), hidden: new Map() }
  const lines = []
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      if (e && typeof e === 'object' && e.edit) lines.push(e)
    } catch (_) {
      // a torn line mid-sync: the next read has it whole
    }
  }
  lines.sort((a, b) => String(a.time).localeCompare(String(b.time)))
  for (const e of lines) {
    if (e.edit === 'category' && e.id) edits.category.set(e.id, String(e.value ?? ''))
    else if (e.edit === 'category' && e.merchant) edits.merchant.set(String(e.merchant).toUpperCase(), String(e.value ?? ''))
    else if (e.edit === 'amount' && e.id && Number.isFinite(Number(e.value))) edits.amount.set(e.id, Number(e.value))
    else if ((e.edit === 'hide' || e.edit === 'unhide') && e.id) edits.hidden.set(e.id, e.edit === 'hide')
  }
  return edits
}

function applyEdits(p, edits) {
  const changed = []
  if (p.amount !== undefined) {
    const own = edits.category.get(p.id)
    const merchant = edits.merchant.get(String(p.merchant || '').toUpperCase())
    const picked = own ?? merchant
    if (picked !== undefined && picked !== p.category) {
      p.category = picked === 'other' ? '' : picked
      changed.push('category')
    }
    if (edits.amount.has(p.id)) {
      p.kzt = edits.amount.get(p.id)
      changed.push('amount')
    }
  }
  if (edits.hidden.get(p.id)) p.hidden = true
  if (changed.length) p.edited = changed
  return p
}

// Every category in use: the table's, the ones corrections gave (a new category exists only by
// being given to a payment), and "other". The "Log Expense" menu and the apps' pickers.
function categories(editsText) {
  const edits = readEdits(editsText)
  const table = [...new Set(Object.values(CATEGORIES))]
  const added = [...new Set([...edits.category.values(), ...edits.merchant.values()])]
    .filter((c) => c && c !== 'other' && !table.includes(c))
    .sort()
  return [...table, ...added, 'other']
}

// Every data file's text joined (JSON Lines) -> parsed pushes, oldest first: probes and repeated
// pushes dropped, everything else kept, payments or not, each with its `id` and the corrections
// from `editsText` applied. Used by reparse.mjs and by the Expenses apps (run in JavaScriptCore),
// so all count the same. A line that is not JSON (iCloud mid-sync, a torn append) is kept as a
// push titled "unreadable line" rather than dropped or fatal.
function reparseLines(text, editsText) {
  const edits = readEdits(editsText)
  const seen = new Map() // push without time -> when it was last seen, in ms
  const out = []
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue
    let n
    try {
      n = JSON.parse(line)
    } catch (e) {
      out.push({ time: '', app: '', title: 'unreadable line', body: line, error: String(e), id: pushId({ body: line }) })
      continue
    }
    // A hand run of the shortcut on the phone appends one probe line (it asks the write
    // permission once); it is no payment.
    if (!n || typeof n !== 'object' || n.probe) continue
    const key = JSON.stringify([n.app, n.title, n.subtitle, n.body])
    const at = Date.parse(n.time)
    const before = seen.get(key)
    seen.set(key, at)
    if (before !== undefined && at - before < SAME_PUSH_MS) continue
    const p = parse(n)
    p.id = pushId(p)
    out.push(applyEdits(p, edits))
  }
  // Files are read one after another; the list is in time order whatever the file order, lines
  // with no time (unreadable) last, in the order met.
  const timed = out.filter((p) => p.time).sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
  return [...timed, ...out.filter((p) => !p.time)]
}

if (typeof module !== 'undefined') module.exports = { parse, reparseLines, categories, pushId, PARSERS, CATEGORIES }
