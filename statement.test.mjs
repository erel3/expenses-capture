import { test } from 'node:test'
import assert from 'node:assert/strict'
import lib from './parse.js'

// A Kaspi Gold statement as PDFKit gives its text (typed by hand: no real names, card *0000).
const statement = (from, to, rows) => `Приложение к Справке №1 от 25 ноября 2026
ВЫПИСКА
по Kaspi Gold за период с ${from} по ${to}
Дата Сумма Операция Детали
${rows.join('\n')}
АО «Kaspi Bank», БИК CASPKZKA, www.kaspi.kz
- Сумма заблокирована. Банк ожидает подтверждения от платежной системы.
Раздел «Краткое содержание операций по карте»`

const rows = [
  '25.11.26 - 1 900,00 ₸ Покупка YANDEX.GO', // the issue day: partial, left out
  '24.11.26 - 1 400,00 ₸ Покупка ИП ТЕСТ',
  '24.11.26 - 1 400,00 ₸ Покупка ИП ТЕСТ', // two identical coffees
  '24.11.26 - 12 722,00 ₸ Покупка RYADOM',
  '23.11.26 - 14 607,97 ₸ (- 28,74 EUR)',
  'Покупка LinkedIn P0000000000',
  '23.11.26 - 5 000,00 ₸ Перевод На карту Freedom Finance Bank*0000',
  '23.11.26 - 5 305,00 ₸ Перевод Тест Т.',
  '23.11.26 - 149,00 ₸ Разное Комиссия за перевод на карту др. банка',
  '23.11.26 + 200 000,00 ₸ Поступление со своего счета',
  'С Kaspi Депозита',
  '22.11.26 - 581,03 ₸ Покупка FACEIT',
  'Курсовая разница',
  '22.11.26 - 50 000,00 ₸ Снятие Банкомат',
  '22.11.26 + 204,50 ₸ Покупка WOLT.COM',
]
const lines = (text) => lib.parseStatement(text).map((l) => JSON.stringify(l)).join('\n')
const file = lines(statement('25.11.25', '25.11.26', rows))
const byMerchant = (out, m) => out.filter((p) => p.merchant === m)

test('a statement becomes a header and one line per row, the partial issue day left out', () => {
  const parsed = lib.parseStatement(statement('25.11.25', '25.11.26', rows))
  assert.deepEqual(parsed[0], { statement: 'kaspi-gold', from: '2025-11-25', to: '2026-11-25', issued: '2026-11-25' })
  assert.equal(parsed.length - 1, rows.filter((r) => /^\d\d\./.test(r)).length - 1)
  assert.ok(!parsed.some((l) => l.date === '2026-11-25'))
})

test('statement rows: purchases, refunds, foreign, transfers, fees, cash, settlement, money in', () => {
  const out = lib.reparseLines(file)
  assert.deepEqual(byMerchant(out, 'ИП ТЕСТ').map((p) => p.kzt), [1400, 1400]) // two coffees stay two
  const linkedin = byMerchant(out, 'LinkedIn P0000000000')[0]
  assert.deepEqual([linkedin.amount, linkedin.currency, linkedin.kzt, linkedin.category], [28.74, 'EUR', 14607.97, 'subscriptions'])
  assert.equal(byMerchant(out, 'Тест Т.')[0].category, 'transfers')
  assert.equal(byMerchant(out, 'Комиссия за перевод на карту др. банка')[0].category, 'fees')
  assert.equal(byMerchant(out, 'Банкомат')[0].category, 'cash')
  assert.equal(byMerchant(out, 'FACEIT')[0].kzt, 581.03)
  assert.equal(byMerchant(out, 'WOLT.COM')[0].kzt, -204.5)
  // money in is income, the Kaspi Deposit paying back included
  const deposit = out.find((p) => p.operation === 'Поступление со своего счета')
  assert.deepEqual([deposit.kind, deposit.kzt, deposit.category], ['income', 200000, 'deposit'])
})

test('a transfer to an own card is still money leaving the card: spending in own accounts', () => {
  const edits = JSON.stringify({ time: '2026-11-25T12:00:00+05:00', edit: 'own', value: '*0000' })
  const own = lib.reparseLines(file, edits).find((p) => String(p.merchant).includes('Freedom'))
  assert.deepEqual([own.kind, own.kzt, own.category], [undefined, 5000, 'own accounts'])
})

test('income minus spending is the balance change', () => {
  const out = lib.reparseLines(file)
  const income = out.filter((p) => p.kind === 'income').reduce((a, p) => a + p.kzt, 0)
  const spent = out.filter((p) => p.amount !== undefined && p.kind !== 'income').reduce((a, p) => a + p.kzt, 0)
  // every row of the fixture but the issue day's: + 200 000 + 204,50 in; the rest out
  assert.equal(Math.round((income - spent) * 100) / 100, 200000 - (1400 * 2 + 12722 + 14607.97 + 5000 + 5305 + 149 + 581.03 + 50000 - 204.5))
})

test('overlapping statements give every row once', () => {
  const older = lines(statement('25.11.24', '25.11.25', ['25.11.25 - 700,00 ₸ Покупка SMALL']))
  const newer = lines(statement('25.11.25', '25.11.26', ['25.11.25 - 700,00 ₸ Покупка SMALL', ...rows]))
  // the older statement was issued later than its end: its last day is whole and kept
  const out = lib.reparseLines([older, newer].join('\n'))
  assert.equal(byMerchant(out, 'SMALL').length, 1)
})

test('pushes of a covered day fold into their statement rows; the rest stay', () => {
  const push = (time, body) => JSON.stringify({ time, app: 'Kaspi.kz', title: 'Kaspi Gold', subtitle: '', body })
  const manual = JSON.stringify({ time: '2026-11-23T18:00:00+05:00', app: 'Manual', title: 'Rent share', subtitle: 'home', body: '5305' })
  const data = [
    file,
    push('2026-11-24T12:39:00+05:00', 'Покупка: 12 722 ₸\nRYADOM\nДоступно: 1 ₸'),
    push('2026-11-23T17:12:00+05:00', 'Покупка: 28,74 € (14 607,97 ₸)\nLinkedIn P0000000000\nДоступно: 1 ₸'),
    push('2026-11-24T20:00:00+05:00', 'Покупка: 999 ₸\nNOT IN THE STATEMENT\nДоступно: 1 ₸'), // statement wins: dropped
    push('2026-11-25T10:43:00+05:00', 'Покупка: 1 900 ₸\nYANDEX.GO\nДоступно: 1 ₸'), // today: not covered, kept
    manual,
  ].join('\n')
  const ryadomPush = lib.reparseLines(data.split('\n').slice(-5).join('\n')).find((p) => p.merchant === 'RYADOM')
  const edits = JSON.stringify({ time: '2026-11-24T13:00:00+05:00', edit: 'category', id: ryadomPush.id, value: 'groceries' })
  const out = lib.reparseLines(data, edits)
  const ryadom = byMerchant(out, 'RYADOM')
  assert.equal(ryadom.length, 1)
  assert.equal(ryadom[0].app, 'Kaspi statement')
  assert.equal(ryadom[0].time, '2026-11-24T12:39:00+05:00') // the push's time
  assert.equal(ryadom[0].category, 'groceries') // a correction made on the push still applies
  assert.equal(byMerchant(out, 'LinkedIn P0000000000').length, 1)
  assert.equal(byMerchant(out, 'NOT IN THE STATEMENT').length, 0)
  assert.equal(byMerchant(out, 'YANDEX.GO').length, 1)
  const rent = out.filter((p) => p.kzt === 5305)
  assert.equal(rent.length, 1) // the manual transfer folded into the statement's
  assert.equal(rent[0].category, 'home')
})

test('a manual cash entry with a card payment\'s amount stays its own payment', () => {
  const cash = JSON.stringify({ time: '2026-11-24T09:00:00+05:00', app: 'Manual', title: 'Coffee', subtitle: 'cash', body: '12722' })
  const card = JSON.stringify({ time: '2026-11-24T09:00:00+05:00', app: 'Manual', title: 'Coffee', subtitle: 'food', body: '1400' })
  const out = lib.reparseLines([file, cash, card].join('\n'))
  assert.equal(out.filter((p) => p.kzt === 12722).length, 2) // RYADOM by card + the cash coffee
  assert.equal(out.filter((p) => p.kzt === 1400).length, 3) // two ИП ТЕСТ coffees + the typed one
})
