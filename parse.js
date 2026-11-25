// One payment notification in, one line of payments.json out: the notification as received
// (time, app, title, body) plus, when a parser knows the push, amount, currency, merchant and
// category. The parsed fields are derived: reparse.mjs rewrites them from the received ones.
// This file runs in two places: inside the "Log Payment" shortcut, where build.py pastes it into
// an HTML page that WebKit renders (so: plain browser JS, no imports, never the text of a
// closing script tag), and in node for the tests and reparse.mjs.

// The operations a Kaspi Gold statement lists, longest first (one is a prefix of another).
const STATEMENT_OPS = ['Поступление со своего счета', 'Перевод на свой счет', 'Пополнение', 'Покупка', 'Перевод', 'Разное', 'Снятие']

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
    // Not a statement row: those have their own parser below ("Kaspi statement" matched here once).
    match: (n) => n.app !== 'Kaspi statement' && (/kaspi/i.test(n.app) || /kaspi/i.test(n.title)),
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
  {
    // A row of a Kaspi Gold statement (PDF, imported by the apps; parseStatement below), its text
    // as PDFKit gives it: "23.11.26 - 14 607,97 ₸ (- 28,74 EUR)\nПокупка LinkedIn P0000000000", or
    // "22.11.26 - 581,03 ₸ Покупка FACEIT\nКурсовая разница" (a foreign payment's final settlement).
    // Purchases, transfers, fees and cash are spending; money in and moves between own accounts are
    // not (kind "income" / "own": no amount, out of every total and list).
    match: (n) => n.app === 'Kaspi statement',
    parse(n) {
      const lines = n.body.split('\n')
      const m = lines[0].match(/^\d\d\.\d\d\.\d\d ([-+]) ([\d\s]+,\d\d) ₸ ?(.*)$/)
      if (!m) return null
      const parts = [m[3], ...lines.slice(1)].map((l) => l.trim()).filter(Boolean)
      const fx = (parts[0] || '').match(/^\(([-+]) ([\d\s]+,\d\d) ([A-Z]{3})\)$/)
      if (fx) parts.shift()
      const rest = parts.join('\n')
      const op = STATEMENT_OPS.find((o) => rest.startsWith(o))
      if (!op) return null
      let details = rest.slice(op.length).replace(/\s+/g, ' ').trim()
      const settlement = /Курсовая разница$/.test(details)
      if (settlement) details = details.replace(/\s*Курсовая разница$/, '')
      const spent = (m[1] === '-' ? 1 : -1) * number(m[2])
      const common = { dateOnly: true, operation: op, merchant: details }
      if (op === 'Пополнение' || op === 'Поступление со своего счета') return { ...common, kind: 'income' }
      if (op === 'Перевод на свой счет') return { ...common, kind: 'own' }
      const money = fx
        ? { amount: (fx[1] === '-' ? 1 : -1) * number(fx[2]), currency: fx[3], kzt: spent }
        : { amount: spent, currency: '₸', kzt: spent }
      if (op === 'Перевод') return { ...common, ...money, category: 'transfers', transfer: true }
      if (op === 'Разное') return { ...common, ...money, category: 'fees' }
      if (op === 'Снятие') return { ...common, ...money, category: 'cash' }
      return { ...common, ...money, ...(settlement ? { settlement: true } : {}) }
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
  for (const k of ['time', 'amount', 'kzt', 'currency', 'merchant', 'category', 'error', 'id', 'hidden', 'edited',
    'kind', 'dateOnly', 'operation', 'transfer', 'settlement', 'aliases', 'merged']) {
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
    // Money in, a move between own accounts: understood, but no payment.
    if (hit.amount === undefined) return { ...note, ...hit }
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
  // `seq` (a statement row's place in its day) only when present: older ids stay what they were.
  const fields = [n.time, n.app, n.title, n.body, ...(n.seq === undefined ? [] : [n.seq])]
  const text = fields.map((v) => String(v ?? '')).join('|')
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
  const edits = { category: new Map(), merchant: new Map(), amount: new Map(), hidden: new Map(), own: new Set() }
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
  // By the moment, not the text: the two apps may write times in different offsets.
  lines.sort((a, b) => (Date.parse(a.time) || 0) - (Date.parse(b.time) || 0))
  for (const e of lines) {
    if (e.edit === 'category' && e.id) edits.category.set(e.id, String(e.value ?? ''))
    else if (e.edit === 'category' && e.merchant) edits.merchant.set(String(e.merchant).toUpperCase(), String(e.value ?? ''))
    else if (e.edit === 'amount' && e.id && Number.isFinite(Number(e.value))) edits.amount.set(e.id, Number(e.value))
    else if ((e.edit === 'hide' || e.edit === 'unhide') && e.id) edits.hidden.set(e.id, e.edit === 'hide')
    // {"edit": "own", "value": "*1858"}: a transfer whose details hold this is to the owner's own
    // card or account, so no spending ("not-own" takes it back).
    else if (e.edit === 'own' && e.value) edits.own.add(String(e.value))
    else if (e.edit === 'not-own' && e.value) edits.own.delete(String(e.value))
  }
  return edits
}

function applyEdits(p, edits) {
  // A row merged from a push or a manual entry answers to their ids too: a correction made on the
  // push before the statement came keeps working.
  const ids = [p.id, ...(p.aliases || [])]
  const latest = (map) => ids.map((id) => map.get(id)).find((v) => v !== undefined)
  if (p.transfer && [...edits.own].some((own) => String(p.merchant || '').includes(own))) {
    for (const k of ['amount', 'kzt', 'currency', 'category', 'transfer']) delete p[k]
    p.kind = 'own'
  }
  const changed = []
  if (p.amount !== undefined) {
    const own = latest(edits.category)
    const merchant = edits.merchant.get(String(p.merchant || '').toUpperCase())
    const picked = own ?? merchant
    if (picked !== undefined && picked !== p.category) {
      p.category = picked === 'other' ? '' : picked
      changed.push('category')
    }
    const amount = latest(edits.amount)
    if (amount !== undefined) {
      p.kzt = amount
      changed.push('amount')
    }
  }
  if (latest(edits.hidden)) p.hidden = true
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
  // Every line first, then in time order: the files are read one after another (Mac-2026.json
  // sorts before archive-2026.json), and the duplicate rule below must meet each push after the
  // earlier ones, or an older line looks like a repeat of a newer one and is dropped (seen
  // 2026-11-25: a manual "Testing 200" from 15:25 vanished behind the same entry from 16:05).
  const lines = []
  const unreadable = []
  const statements = []
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue
    let n
    try {
      n = JSON.parse(line)
    } catch (e) {
      unreadable.push({ time: '', app: '', title: 'unreadable line', body: line, error: String(e), id: pushId({ body: line }) })
      continue
    }
    // A hand run of a shortcut appends one probe line (it asks the write permission once); it is
    // no payment.
    if (!n || typeof n !== 'object' || n.probe) continue
    // A statement file's first line: the days it covers, not a push.
    if (n.statement && !n.app) {
      statements.push(n)
      continue
    }
    lines.push(n)
  }
  const at = (n) => Date.parse(n.time) || 0
  lines.sort((a, b) => at(a) - at(b))
  const seen = new Map() // push without time -> when it was last seen, in ms
  // The same line twice (time included) is one push, wherever it sits: a file and its archive
  // copy, read side by side while the old layout is being moved.
  const ids = new Set()
  const out = []
  for (const n of lines) {
    const id = pushId(n)
    if (ids.has(id)) continue
    ids.add(id)
    // Only a bank push can arrive twice (the automation ran twice for one notification). A manual
    // entry is typed on purpose: two identical ones a minute apart are two payments (owner,
    // 2026-11-25: skip only the notification's real duplicate).
    // Not statement rows either: the bank's own list, every row a payment (two identical coffees on
    // one day carry the same noon time); overlapping statements meet through the ids instead.
    if (n.app !== 'Manual' && n.app !== 'Kaspi statement') {
      const key = JSON.stringify([n.app, n.title, n.subtitle, n.body])
      const before = seen.get(key)
      seen.set(key, at(n))
      if (before !== undefined && at(n) - before < SAME_PUSH_MS) continue
    }
    const p = parse(n)
    p.id = id
    out.push(p)
  }
  return [...mergeStatements(out, statements).map((p) => applyEdits(p, edits)), ...unreadable]
}

// The local day of a line ("2026-11-23"): what statements and pushes are matched by.
function dayOf(p) {
  return String(p.time || '').slice(0, 10)
}

const sameMerchant = (a, b) => {
  const x = String(a || '').toUpperCase().trim()
  const y = String(b || '').toUpperCase().trim()
  return Boolean(x && y) && (x.startsWith(y) || y.startsWith(x))
}

// Statements win (owner, 2026-11-25) for every day one covers (from <= day < to; `to` itself only
// when the statement was issued later, i.e. the day is whole): the bank's list is complete there.
// A Kaspi Gold push of such a day is folded into its statement row (same tenge, the same or a cut
// merchant first): the row takes the push's exact time and keeps its id as an alias, so
// corrections made on the push still apply; a push with no row is dropped. A manual entry with
// the same tenge on that day is folded into a statement TRANSFER the same way (never a cash entry,
// never into a card purchase: those are two payments), its category kept when the row has none;
// an unmatched manual entry stays (cash, another bank). Days no statement covers are left as they are.
function mergeStatements(list, statements) {
  if (!statements.length) return list
  const covered = (day) => statements.some((s) => s.from <= day && (day < s.to || (s.issued && day === s.to && s.issued > s.to)))
  const rows = new Map() // day -> statement payment rows
  for (const p of list) {
    if (p.app === 'Kaspi statement' && p.amount !== undefined) {
      const day = dayOf(p)
      if (!rows.has(day)) rows.set(day, [])
      rows.get(day).push(p)
    }
  }
  const used = new Set()
  const fold = (row, other, { time }) => {
    used.add(row)
    row.aliases = [...(row.aliases || []), other.id]
    row.merged = [...(row.merged || []), other.app]
    if (time) {
      row.time = other.time
      row.dateOnly = false
    }
  }
  const out = []
  for (const p of list) {
    const day = dayOf(p)
    const kaspiPush = p.app !== 'Kaspi statement' && /kaspi/i.test(p.app) && p.title === 'Kaspi Gold' && p.amount !== undefined
    const manual = p.app === 'Manual' && p.amount !== undefined
    if (!(kaspiPush || manual) || !covered(day)) {
      out.push(p)
      continue
    }
    const free = (rows.get(day) || []).filter((r) => !used.has(r) && r.kzt === p.kzt)
    if (kaspiPush) {
      const row = free.find((r) => sameMerchant(r.merchant, p.merchant)) || free[0]
      if (row) fold(row, p, { time: true })
      continue // statement wins: a push the bank did not list is no payment of that card
    }
    // Only into a transfer, and never a cash entry: a cash coffee of 1 500 ₸ on a day a card also
    // paid 1 500 ₸ is two payments (what is typed by hand that a statement also lists is a transfer).
    const row = p.category === 'cash' ? undefined : free.find((r) => r.transfer)
    if (!row) {
      out.push(p)
      continue
    }
    fold(row, p, { time: false })
    if (p.category && (!row.category || row.category === 'transfers')) row.category = p.category
  }
  return out
}

// Kaspi Gold statement text (PDFKit, every page joined) -> the lines its file holds: a header
// {"statement": "kaspi-gold", "from", "to", "issued"} and one line per row {"app": "Kaspi
// statement", "time" (the day, noon), "date", "seq", "body", "statement"}. `seq` is the row's place
// in its day counted from the day's oldest, so the same day read from two overlapping statements
// gets the same ids and two identical coffees stay two. The day the statement was issued on is
// partial: its rows are left out (the next statement brings it whole). Throws on anything else.
function parseStatement(text) {
  const all = String(text).split('\n').map((l) => l.trim())
  const full = all.join('\n')
  if (!/Kaspi Gold/.test(full)) throw new Error('not a Kaspi Gold statement')
  const period = full.match(/за период с (\d\d)\.(\d\d)\.(\d\d) по (\d\d)\.(\d\d)\.(\d\d)/)
  if (!period) throw new Error('no statement period found')
  const iso = (d, m, y) => `20${y}-${m}-${d}`
  const from = iso(period[1], period[2], period[3])
  const to = iso(period[4], period[5], period[6])
  const months = { января: '01', февраля: '02', марта: '03', апреля: '04', мая: '05', июня: '06', июля: '07',
    августа: '08', сентября: '09', октября: '10', ноября: '11', декабря: '12' }
  const issuedMatch = full.match(/от (\d{1,2}) ([а-я]+) (\d{4})/)
  const issued = issuedMatch && months[issuedMatch[2]]
    ? `${issuedMatch[3]}-${months[issuedMatch[2]]}-${issuedMatch[1].padStart(2, '0')}` : to
  const start = all.findIndex((l) => l.startsWith('Дата Сумма Операция'))
  if (start < 0) throw new Error('no operations table found')
  const rows = []
  for (const line of all.slice(start + 1)) {
    if (line.startsWith('- Сумма заблокирована') || line.startsWith('Раздел «')) break
    if (!line || line.startsWith('Приложение к Справке') || line.includes('АО «Kaspi Bank»') || line.startsWith('Дата Сумма')) continue
    if (/^\d\d\.\d\d\.\d\d [-+] /.test(line)) rows.push([line])
    else if (rows.length) rows[rows.length - 1].push(line)
  }
  const name = `${from}_${to}`
  const byDay = new Map()
  for (const r of rows) {
    const [d, m, y] = r[0].slice(0, 8).split('.')
    const date = iso(d, m, y)
    if (!byDay.has(date)) byDay.set(date, [])
    byDay.get(date).push(r.join('\n'))
  }
  const out = [{ statement: 'kaspi-gold', from, to, issued }]
  for (const [date, bodies] of byDay) {
    if (date === issued) continue
    // The statement lists a day newest first: count from its oldest.
    bodies.slice().reverse().forEach((body, i) => {
      out.push({ app: 'Kaspi statement', time: `${date}T12:00:00+05:00`, date, seq: i + 1, body, statement: name })
    })
  }
  return out
}

if (typeof module !== 'undefined') module.exports = { parse, reparseLines, parseStatement, categories, pushId, PARSERS, CATEGORIES }
