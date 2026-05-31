/**
 * Daily recurrence chain simulation (no DB / OneSignal).
 * Usage: node scripts/test-daily-recurrence-simulation.mjs
 */
import {
  computeNextScheduleAt,
  recurrenceAdvanceFrom,
  recurrenceKindLabel,
} from '../src/lib/notificationRecurrence.js'

let passed = 0
let failed = 0

function assert(cond, msg) {
  if (cond) {
    passed += 1
    return
  }
  failed += 1
  console.error('FAIL:', msg)
}

function fmtLocal(iso, tz = 'Africa/Dar_es_Salaam') {
  return new Date(iso).toLocaleString('en-US', { timeZone: tz })
}

// User example: First send 2026-06-01 10:00 PM (EAT = UTC+3 => 19:00 UTC)
const anchor = '2026-06-01T19:00:00.000Z'
let scheduleAt = anchor

console.log('=== Daily recurrence chain (10:00 PM anchor) ===')

for (let fire = 1; fire <= 3; fire += 1) {
  const sentAtIso = new Date(new Date(scheduleAt).getTime() + 5_000).toISOString()
  const from = recurrenceAdvanceFrom({ kind: 'daily', scheduleAt, sentAtIso })
  const nextAt = computeNextScheduleAt({
    from,
    kind: 'daily',
    interval: null,
    anchorAt: anchor,
  })
  console.log(
    JSON.stringify({
      fire,
      scheduledOccurrence: scheduleAt,
      sentAtIso,
      advanceFrom: from,
      nextScheduleAt: nextAt,
      nextLocal: nextAt ? fmtLocal(nextAt) : null,
      templateStatus: 'scheduled (unchanged)',
    }),
  )
  assert(from === scheduleAt, `fire ${fire}: advance uses schedule_at not sentAt`)
  assert(nextAt != null, `fire ${fire}: next occurrence computed`)
  scheduleAt = nextAt
}

assert(scheduleAt === '2026-06-04T19:00:00.000Z', 'after 3 fires next is June 4 10PM EAT')

// Late flush must not skip a day
const lateSent = '2026-06-02T22:00:00.000Z'
const lateSchedule = '2026-06-01T19:00:00.000Z'
const lateFrom = recurrenceAdvanceFrom({ kind: 'daily', scheduleAt: lateSchedule, sentAtIso: lateSent })
const lateNext = computeNextScheduleAt({
  from: lateFrom,
  kind: 'daily',
  interval: null,
  anchorAt: anchor,
})
assert(lateNext === '2026-06-02T19:00:00.000Z', 'late send still schedules next day not day+2')
console.log('Late flush next:', lateNext, fmtLocal(lateNext))

// End date: last allowed occurrence is until (inclusive at same clock time)
const until = '2026-06-03T19:00:00.000Z'
const afterJune2 = computeNextScheduleAt({
  from: '2026-06-02T19:00:00.000Z',
  kind: 'daily',
  interval: null,
  anchorAt: anchor,
})
assert(afterJune2 === until, 'June 2 fire => next June 3 (still within end date)')
const afterJune3 = computeNextScheduleAt({
  from: until,
  kind: 'daily',
  interval: null,
  anchorAt: anchor,
})
const shouldCancel = afterJune3 && new Date(afterJune3).getTime() > new Date(until).getTime()
assert(shouldCancel === true, 'June 3 fire => next June 4 exceeds end date => cancel')
console.log('End date check: after June 3 next', afterJune3, 'until', until, 'cancel=', shouldCancel)

console.log('Label:', recurrenceKindLabel('daily', null))
console.log(JSON.stringify({ passed, failed, ok: failed === 0 }, null, 2))
process.exit(failed > 0 ? 1 : 0)
