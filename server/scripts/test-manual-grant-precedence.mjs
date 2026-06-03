import { manualGrantIsNewerThanCompletedPayment } from '../src/billingStore.js'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const oldPayment = { created_at: '2026-05-01T10:00:00.000Z', updated_at: '2026-05-01T10:05:00.000Z' }
const newGrant = { created_at: '2026-06-03T17:56:01.659Z', duration_days: 30, id: 25 }

assert(
  manualGrantIsNewerThanCompletedPayment(newGrant, oldPayment) === true,
  'grant after payment should override',
)
assert(
  manualGrantIsNewerThanCompletedPayment(oldPayment, newGrant) === false,
  'payment after grant should not be overridden by older grant row used as grant arg',
)
assert(
  manualGrantIsNewerThanCompletedPayment(newGrant, null) === true,
  'grant with no payment should override',
)
assert(
  manualGrantIsNewerThanCompletedPayment(null, oldPayment) === false,
  'no grant',
)

const sameTime = { created_at: '2026-06-01T00:00:00.000Z' }
assert(
  manualGrantIsNewerThanCompletedPayment(
    { created_at: '2026-06-01T00:00:00.000Z' },
    sameTime,
  ) === true,
  'tie goes to manual grant',
)

console.log('All manual-grant precedence unit tests passed.')
