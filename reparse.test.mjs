import { test } from 'node:test'
import assert from 'node:assert/strict'
import lib from './parse.js'

const reparse = (lines) => lib.reparseLines(lines.join('\n'))

const debit = {
  app: 'Freedom',
  title: 'Списана сумма за заказ Arbuz.kz',
  subtitle: '',
  body: '-18 078 ₸\nДоступно 1 000,00 ₸\nСписано с Deposit Card **0000',
}
const at = (time, n = debit) => JSON.stringify({ time, ...n })

test('the same push twice within a minute is one payment', () => {
  const out = reparse([at('2026-11-23T12:19:39+05:00'), at('2026-11-23T12:19:40+05:00')])
  assert.equal(out.length, 1)
  assert.equal(out[0].time, '2026-11-23T12:19:39+05:00')
})

test('a repeat with another push between is still one payment', () => {
  const cashback = { app: 'Freedom', title: 'Кешбэк за покупку', subtitle: '', body: '+1 807,8 ₸\nARBUZ' }
  const out = reparse([
    at('2026-11-23T12:19:39+05:00'),
    at('2026-11-23T12:19:42+05:00', cashback),
    at('2026-11-23T12:19:43+05:00'),
    at('2026-11-23T12:19:44+05:00', cashback),
  ])
  assert.deepEqual(out.map((n) => n.title), [debit.title, cashback.title])
})

test('the same push a minute or more later is kept', () => {
  assert.equal(reparse([at('2026-11-23T12:19:00+05:00'), at('2026-11-23T12:20:00+05:00')]).length, 2)
})

test('another balance is another payment', () => {
  const second = { ...debit, body: debit.body.replace('1 000,00', '982,00') }
  assert.equal(reparse([at('2026-11-23T12:19:39+05:00'), at('2026-11-23T12:19:40+05:00', second)]).length, 2)
})

test('probes and blank lines are skipped', () => {
  assert.equal(reparse(['', JSON.stringify({ time: '2026-11-23T12:00:00+05:00', probe: true })]).length, 0)
})

test('a line that is not JSON is kept as an unreadable push', () => {
  const out = reparse([at('2026-11-23T12:19:39+05:00'), '{"time":"2026-11-23T12:20', ''])
  assert.equal(out.length, 2)
  assert.equal(out[1].title, 'unreadable line')
  assert.equal(out[1].body, '{"time":"2026-11-23T12:20')
  assert.ok(!('amount' in out[1]))
})

// Corrections written by the apps (edits-<device>.json).
const wolt = (time, amount) => JSON.stringify({ time, app: 'Kaspi.kz', title: 'Kaspi Gold', subtitle: '',
  body: `Покупка: ${amount} ₸\nWOLT.COM\nДоступно: 1 ₸` })
const edit = (e) => JSON.stringify(e)

test('every push gets an id that does not change between reads', () => {
  const lines = [wolt('2026-11-20T10:00:00+05:00', 1000), wolt('2026-11-21T10:00:00+05:00', 2000)]
  const first = reparse(lines)
  assert.equal(first.length, 2)
  assert.match(first[0].id, /^[0-9a-f]{16}$/)
  assert.notEqual(first[0].id, first[1].id)
  assert.deepEqual(reparse(lines).map((p) => p.id), first.map((p) => p.id))
})

test('a payment correction beats the merchant one, which beats the table', () => {
  const lines = [wolt('2026-11-20T10:00:00+05:00', 1000), wolt('2026-11-21T10:00:00+05:00', 2000)]
  const [a, b] = reparse(lines)
  assert.equal(a.category, 'food')  // the table: WOLT -> food
  const edits = [
    edit({ time: '2026-11-22T10:00:00+05:00', edit: 'category', merchant: 'WOLT.COM', value: 'delivery' }),
    edit({ time: '2026-11-21T09:00:00+05:00', edit: 'category', id: a.id, value: 'gifts' }),
  ].join('\n')
  const out = lib.reparseLines(lines.join('\n'), edits)
  assert.equal(out[0].category, 'gifts')  // its own, even though older than the merchant's
  assert.equal(out[1].category, 'delivery')
  assert.deepEqual(out[1].edited, ['category'])
  assert.deepEqual(lib.categories(edits), ['transport', 'food', 'subscriptions', 'delivery', 'gifts', 'other'])
})

test('the latest correction of a target wins, whichever device wrote it', () => {
  const [a] = reparse([wolt('2026-11-20T10:00:00+05:00', 1000)])
  const mac = edit({ time: '2026-11-22T10:00:00+05:00', edit: 'hide', id: a.id })
  const phone = edit({ time: '2026-11-23T10:00:00+05:00', edit: 'unhide', id: a.id })
  assert.equal(lib.reparseLines(wolt('2026-11-20T10:00:00+05:00', 1000), [phone, mac].join('\n'))[0].hidden, undefined)
  assert.equal(lib.reparseLines(wolt('2026-11-20T10:00:00+05:00', 1000), mac)[0].hidden, true)
})

test('an amount correction sets the tenge, the received amount stays', () => {
  const [a] = reparse([wolt('2026-11-20T10:00:00+05:00', 1000)])
  const out = lib.reparseLines(wolt('2026-11-20T10:00:00+05:00', 1000),
    edit({ time: '2026-11-21T10:00:00+05:00', edit: 'amount', id: a.id, value: 950 }))
  assert.equal(out[0].kzt, 950)
  assert.equal(out[0].amount, 1000)
  assert.deepEqual(out[0].edited, ['amount'])
})

test('lines from several files come out in time order', () => {
  const out = reparse([wolt('2026-11-21T10:00:00+05:00', 2000), wolt('2026-11-20T10:00:00+05:00', 1000)])
  assert.deepEqual(out.map((p) => p.amount), [1000, 2000])
})

test('the same line read from two files counts once', () => {
  const limit = (time) => JSON.stringify({ time, app: 'Kaspi.kz', title: 'Kaspi Gold', subtitle: '', body: 'Превышен лимит' })
  const file = [limit('2026-11-25T08:52:00+05:00'), limit('2026-11-25T10:07:00+05:00')]
  // a real repeat an hour later stays two; the archive copy of both adds nothing
  assert.equal(reparse([...file, ...file]).length, 2)
})

test('a newer copy read first does not swallow an older entry (files are read out of time order)', () => {
  const manual = (time) => JSON.stringify({ time, app: 'Manual', title: 'Coffee', subtitle: 'food', body: '1500' })
  // the Mac's file is read before the archive, so the newer line comes first
  const out = reparse([manual('2026-11-25T16:05:00+05:00'), manual('2026-11-24T09:00:00+05:00')])
  assert.deepEqual(out.map((p) => p.time), ['2026-11-24T09:00:00+05:00', '2026-11-25T16:05:00+05:00'])
  // a real double run, read in reverse, is still one
  assert.equal(reparse([manual('2026-11-25T16:05:30+05:00'), manual('2026-11-25T16:05:00+05:00')]).length, 1)
})
