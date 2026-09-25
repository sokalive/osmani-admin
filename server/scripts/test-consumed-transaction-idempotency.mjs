/**
 * Consumed-transaction idempotency.
 * One completed order produces one entitlement window, including after expiry.
 * A different order id is a new payment and may activate.
 */
import assert from 'node:assert/strict'
import { computeMidnightEatExpiryIso } from '../src/lib/subscriptionStacking.js'
import {
  createConsumedOrderActivator,
  isTransactionEntitlementConsumed,
  orderIdsAreDistinct,
  shouldRefuseCreditAlignmentToStartedAt,
} from '../src/lib/consumedTransactionEntitlement.js'

const TXN_A = 'osm_sp_test_txn_a'
const TXN_B = 'osm_sp_test_txn_b'
const creditMs = Date.parse('2026-09-15T09:11:59.047Z')
const firstStarted = '2026-09-15T09:11:59.047Z'
const firstExpiry = computeMidnightEatExpiryIso(8, creditMs)
const regrantStarted = '2026-09-24T13:51:46.699Z'
const regrantExpiry = computeMidnightEatExpiryIso(8, Date.parse(regrantStarted))

assert.equal(firstExpiry, '2026-09-22T21:00:00.000Z')
assert.ok(Date.parse(regrantStarted) > Date.parse(firstExpiry))

function fail(msg) {
  console.error('FAIL', msg)
  process.exit(1)
}

const activator = createConsumedOrderActivator()

// TEST 1 — paid window, then expiry, then verify again.
const first = await activator.activate(TXN_A, { startedAt: firstStarted, expiresAt: firstExpiry })
assert.equal(first.activated, true)
const afterExpiry = Date.parse(firstExpiry) + 60_000
assert.ok(afterExpiry < Date.parse(regrantStarted) || afterExpiry > Date.parse(firstExpiry))
const replay = await activator.activate(TXN_A, { startedAt: regrantStarted, expiresAt: regrantExpiry })
if (replay.activated) fail('expired verify created a second window')
assert.equal(replay.reason, 'already_consumed')
const stored = activator.get(TXN_A)
assert.equal(stored.windows, 1)
assert.equal(stored.startedAt, firstStarted)
assert.equal(stored.expiresAt, firstExpiry)
assert.equal(isTransactionEntitlementConsumed({
  orderId: TXN_A,
  linkedTransactionId: null,
  entitlementConsumedAt: firstStarted,
}), true)
console.log('PASS paid → expired → verify does not re-grant')

// TEST 2 — new transaction after the old one expired.
const second = await activator.activate(TXN_B, {
  startedAt: '2026-09-25T08:00:00.000Z',
  expiresAt: computeMidnightEatExpiryIso(8, Date.parse('2026-09-25T08:00:00.000Z')),
})
assert.equal(second.activated, true)
assert.equal(activator.get(TXN_A).windows, 1)
assert.equal(activator.get(TXN_B).windows, 1)
assert.ok(orderIdsAreDistinct(TXN_A, TXN_B))
console.log('PASS expired txn A + new txn B activates once')

// TEST 3 — same consumed transaction verified 10 times.
for (let i = 0; i < 10; i++) {
  const again = await activator.activate(TXN_A, { startedAt: regrantStarted, expiresAt: regrantExpiry })
  assert.equal(again.activated, false)
}
assert.equal(activator.get(TXN_A).windows, 1)
assert.equal(activator.get(TXN_A).startedAt, firstStarted)
console.log('PASS same transaction verified 10x stays one window')

// TEST 4 — concurrent verify of an already-consumed transaction.
const races = await Promise.all(
  Array.from({ length: 8 }, () =>
    activator.activate(TXN_A, { startedAt: regrantStarted, expiresAt: regrantExpiry }),
  ),
)
assert.equal(races.filter((r) => r.activated).length, 0)
assert.equal(activator.get(TXN_A).windows, 1)
console.log('PASS concurrent verify cannot duplicate an already-consumed window')

// Fresh concurrent first activation: only one succeeds.
const fresh = createConsumedOrderActivator()
const firstRace = await Promise.all(
  Array.from({ length: 8 }, () =>
    fresh.activate('osm_sp_race', { startedAt: firstStarted, expiresAt: firstExpiry }),
  ),
)
assert.equal(firstRace.filter((r) => r.activated).length, 1)
assert.equal(fresh.get('osm_sp_race').windows, 1)
console.log('PASS concurrent first activation writes one window')

// TEST 5 — legitimate renewal stays a new transaction.
const renewal = createConsumedOrderActivator()
await renewal.activate(TXN_A, { startedAt: firstStarted, expiresAt: firstExpiry })
const renewed = await renewal.activate(TXN_B, {
  startedAt: '2026-09-25T08:00:00.000Z',
  expiresAt: computeMidnightEatExpiryIso(8, Date.parse('2026-09-25T08:00:00.000Z')),
})
await renewal.activate(TXN_A, { startedAt: regrantStarted, expiresAt: regrantExpiry })
await renewal.activate(TXN_B, {
  startedAt: '2026-10-01T08:00:00.000Z',
  expiresAt: computeMidnightEatExpiryIso(8, Date.parse('2026-10-01T08:00:00.000Z')),
})
assert.equal(renewal.get(TXN_A).startedAt, firstStarted)
assert.equal(renewal.get(TXN_B).startedAt, '2026-09-25T08:00:00.000Z')
assert.equal(renewed.activated, true)
console.log('PASS legitimate renewal txn B is not blocked by consumed txn A')

// Historical correction must not slide a second window onto the old payment clock.
assert.equal(
  shouldRefuseCreditAlignmentToStartedAt(creditMs, Date.parse(regrantStarted), firstExpiry),
  true,
)
assert.equal(
  shouldRefuseCreditAlignmentToStartedAt(creditMs, creditMs + 60_000, firstExpiry),
  false,
)
console.log('PASS historical alignment refuses a started_at after the original window')

// Expired row link is consumption even when the window is not currently active.
assert.equal(
  isTransactionEntitlementConsumed({
    orderId: TXN_A,
    linkedTransactionId: TXN_A,
    entitlementConsumedAt: null,
  }),
  true,
)
assert.equal(
  isTransactionEntitlementConsumed({
    orderId: TXN_B,
    linkedTransactionId: TXN_A,
    entitlementConsumedAt: null,
  }),
  false,
)
console.log('PASS consumption is the transaction identity, not current expiry')
console.log('ALL CONSUMED-TRANSACTION IDEMPOTENCY CHECKS PASSED')
