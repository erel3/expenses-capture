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
  for (const k of ['time', 'amount', 'kzt', 'currency', 'merchant', 'category', 'error']) {
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
      category: category(hit.merchant),
    }
  } catch (e) {
    return { ...note, error: String(e) }
  }
}

if (typeof module !== 'undefined') module.exports = { parse, PARSERS }
