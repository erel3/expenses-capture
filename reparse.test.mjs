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
