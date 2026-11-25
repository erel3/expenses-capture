import { test } from 'node:test'
import assert from 'node:assert/strict'
import lib from './parse.js'

const { parse } = lib
const time = '2026-11-19T19:23:00+05:00'

// The real push from 2026-11-19 (balance changed), thousands separated by NBSP as Kaspi sends them.
const kaspi = {
  time,
  app: 'Kaspi.kz',
  title: 'Kaspi Gold',
  body: 'Покупка: 3\u00a0080 ₸\nYANDEX.GO\nДоступно: 100\u00a0000,00 ₸',
}

test('kaspi purchase keeps the push and adds parsed fields', () => {
  assert.deepEqual(parse(kaspi), {
    ...kaspi,
    amount: 3080,
    kzt: 3080,
    currency: '₸',
    merchant: 'YANDEX.GO',
    category: 'transport',
  })
})

test('one line of JSON', () => {
  assert.ok(!JSON.stringify(parse(kaspi)).includes('\n'))
})

test('decimal amount, plain spaces, unknown merchant', () => {
  const r = parse({ ...kaspi, body: 'Покупка: 12 499,50 ₸\nSOME SHOP\nДоступно: 1 ₸' })
  assert.equal(r.amount, 12499.5)
  assert.equal(r.merchant, 'SOME SHOP')
  assert.equal(r.category, '')
})

test('foreign currency is kept', () => {
  const r = parse({ ...kaspi, body: 'Покупка: 9,99 $\nSTEAMGAMES.COM\nДоступно: 1 ₸' })
  assert.equal(r.amount, 9.99)
  assert.equal(r.currency, '$')
  assert.ok(!('kzt' in r))
})

test('foreign kaspi purchase keeps the tenge the bank converted it to', () => {
  const r = parse({ ...kaspi, body: 'Покупка: 95,88 $ (43 674,30 ₸)\nFACEIT\nДоступно: 1 ₸' })
  assert.equal(r.amount, 95.88)
  assert.equal(r.currency, '$')
  assert.equal(r.kzt, 43674.3)
  assert.equal(r.merchant, 'FACEIT')
})

test('kaspi refund is a negative amount', () => {
  const r = parse({ ...kaspi, body: 'Отмена покупки: 204,50 ₸\nWOLT.COM\nДоступно: 1 ₸' })
  assert.equal(r.amount, -204.5)
  assert.equal(r.kzt, -204.5)
  assert.equal(r.merchant, 'WOLT.COM')
  assert.equal(r.category, 'food')
})

test('a merchant carrying an invoice number still gets its category', () => {
  const r = parse({
    ...kaspi,
    body: 'Покупка: 28,74 € (14 607,97 ₸)\nLinkedIn P0000000000\nДоступно: 1 ₸',
  })
  assert.equal(r.kzt, 14607.97)
  assert.equal(r.category, 'subscriptions')
})

test('non-purchase kaspi push is kept as received', () => {
  const n = { ...kaspi, body: 'Перевод: 5 000 ₸\nАлия К.\nДоступно: 1 ₸' }
  assert.deepEqual(parse(n), n)
})

test('unknown app is kept as received', () => {
  const n = { time, app: 'Yandex Go', title: 'Trip', body: 'Paid 3 080 ₸' }
  assert.deepEqual(parse(n), n)
})

test('reparse drops stale parsed fields', () => {
  const stale = { ...kaspi, body: 'Перевод: 1 ₸', amount: 1, merchant: 'X', category: 'food' }
  assert.deepEqual(parse(stale), { ...kaspi, body: 'Перевод: 1 ₸' })
})

// The real Freedom pushes from 2026-11-20 (balance changed).
const freedom = {
  time,
  app: 'Freedom',
  title: 'Списана сумма за заказ Arbuz.kz',
  body: '-16 586 ₸\nДоступно 1 000,00 ₸\nСписано с Deposit Card **0000',
}

test('freedom debit becomes a payment', () => {
  assert.deepEqual(parse(freedom), {
    ...freedom,
    amount: 16586,
    kzt: 16586,
    currency: '₸',
    merchant: 'Arbuz.kz',
    category: 'food',
  })
})

test('freedom cashback is kept as received', () => {
  const n = { time, app: 'Freedom', title: 'Кешбэк за покупку', body: '+1 658,6 ₸\nARBUZ' }
  assert.deepEqual(parse(n), n)
})

test('freedom refund is a negative amount', () => {
  const r = parse({
    time,
    app: 'Freedom',
    title: 'Возврат денег за заказ Arbuz.kz',
    body: '+588 ₸\nARBUZ\nДоступно 1 000,00 KZT\nПополнено Deposit Card **0000',
  })
  assert.equal(r.amount, -588)
  assert.equal(r.merchant, 'Arbuz.kz')
  assert.equal(r.category, 'food')
})

test('freedom cashback cancel is kept as received', () => {
  const n = { time, app: 'Freedom', title: 'Отмена кешбэка', body: 'ARBUZ\n—58,8 ₸' }
  assert.deepEqual(parse(n), n)
})

test('freedom debit with an unknown title has no merchant', () => {
  const r = parse({ ...freedom, title: 'Оплата' })
  assert.equal(r.amount, 16586)
  assert.equal(r.merchant, '')
})

test('a body that is not text is still kept', () => {
  const r = parse({ time, app: 'Halyk', title: 'Покупка', body: { odd: 1 } })
  assert.equal(r.app, 'Halyk')
  assert.equal(r.body, '[object Object]')
})

test('a parser that throws keeps the push with the error', (t) => {
  lib.PARSERS.unshift({ match: (n) => n.app === 'Boom', parse: () => { throw new Error('boom') } })
  t.after(() => lib.PARSERS.shift())
  const n = { time, app: 'Boom', title: 't', body: 'b' }
  assert.deepEqual(parse(n), { ...n, error: 'Error: boom' })
  assert.ok(!('error' in parse(kaspi)))
})

test('fields the automation adds are kept', () => {
  assert.equal(parse({ ...kaspi, subtitle: 'Карта *1234' }).subtitle, 'Карта *1234')
})

test('missing time is stamped with local offset', () => {
  assert.match(parse({ ...kaspi, time: undefined }).time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/)
})

test('a manual entry keeps the category picked for it', () => {
  const n = { time, app: 'Manual', title: 'Coffee with Alex', subtitle: 'food', body: '1 500,5' }
  assert.deepEqual(parse(n), { ...n, amount: 1500.5, currency: '₸', merchant: 'Coffee with Alex', kzt: 1500.5, category: 'food' })
  // a reparse sees its own output again: the pick survives
  assert.equal(parse(parse(n)).category, 'food')
})

test('a manual entry without a category falls back to the merchant table', () => {
  const r = parse({ time, app: 'Manual', title: 'YANDEX.GO', subtitle: 'other', body: '2480' })
  assert.equal(r.category, 'transport')
  assert.equal(parse({ time, app: 'Manual', title: 'cash', subtitle: 'other', body: '900' }).category, '')
})

test('a manual correction is a negative amount', () => {
  assert.equal(parse({ time, app: 'Manual', title: 'oops', subtitle: 'food', body: '−1500' }).amount, -1500)
})

test('a manual entry with no number is kept raw', () => {
  const n = { time, app: 'Manual', title: 'x', subtitle: 'food', body: '' }
  assert.deepEqual(parse(n), n)
})

test('a Kaspi push of money in: from a person a payback, else greyed', () => {
  const r = parse({ ...kaspi, body: 'Пополнение: 5 000 ₸\nЕржан А.' })
  assert.deepEqual([r.kzt, r.category, r.kind], [-5000, 'transfers', undefined])
  const salary = parse({ ...kaspi, body: 'Пополнение: 300 000 ₸\nЗарплата' })
  assert.deepEqual([salary.kind, salary.kzt], ['income', 300000])
})
