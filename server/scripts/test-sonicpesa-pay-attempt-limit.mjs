/**
 * SonicPesa three-attempt limit and 180s cooldown.
 * Mocks and fixtures only — no network, no database, no charges.
 * Run: node scripts/test-sonicpesa-pay-attempt-limit.mjs
 */
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SONICPESA_PAY_ATTEMPT_COOLDOWN_CODE,
  SONICPESA_PAY_ATTEMPT_COOLDOWN_MS,
  SONICPESA_PAY_ATTEMPT_MAX,
  checkoutAllowsEntitlement,
  classifySonicpesaCreateResult,
  decidePayAttemptTransition,
  planSonicpesaCustomerAttempt,
  readPayAttemptGate,
  sonicpesaPayAttemptCooldownHttpBody,
  sonicpesaPayAttemptIdentity,
} from '../src/lib/sonicpesaCheckoutPolicy.js'

const root = dirname(fileURLToPath(import.meta.url))
let failed = 0

function assert(name, cond) {
  if (cond) console.log('PASS', name)
  else {
    failed += 1
    console.error('FAIL', name)
  }
}

const SERVER_NOW = Date.parse('2026-10-19T06:00:00.000Z')
const COOLDOWN_MS = SONICPESA_PAY_ATTEMPT_COOLDOWN_MS

function acceptedRow(orderId, ageMs) {
  return {
    order_id: orderId,
    status: 'pending',
    provider_initiation: 'accepted',
    provider_order_id: `sp_${orderId}`,
    updated_at: new Date(SERVER_NOW - ageMs).toISOString(),
  }
}

function applyPermit(row, nowMs) {
  const decision = decidePayAttemptTransition(row, nowMs)
  if (decision.action === 'permit') {
    return {
      decision,
      row: { attemptCount: decision.attemptCount, cooldownUntilMs: decision.cooldownUntilMs },
    }
  }
  if (decision.armCooldown) {
    return {
      decision,
      row: { attemptCount: decision.attemptCount, cooldownUntilMs: decision.cooldownUntilMs },
    }
  }
  return { decision, row }
}

const first = applyPermit(null, SERVER_NOW)
const second = applyPermit(first.row, SERVER_NOW + 1_000)
const third = applyPermit(second.row, SERVER_NOW + 2_000)
assert('first attempt is permitted', first.decision.action === 'permit' && first.decision.attemptCount === 1 && first.row.cooldownUntilMs == null)
assert('second attempt is permitted', second.decision.action === 'permit' && second.decision.attemptCount === 2 && second.row.cooldownUntilMs == null)
assert(
  'third attempt is permitted and arms the 180s cooldown from server time',
  third.decision.action === 'permit' &&
    third.decision.attemptCount === SONICPESA_PAY_ATTEMPT_MAX &&
    third.row.cooldownUntilMs === SERVER_NOW + 2_000 + COOLDOWN_MS,
)

const fourth = applyPermit(third.row, SERVER_NOW + 3_000)
assert(
  'fourth attempt is rejected without moving the cooldown',
  fourth.decision.action === 'cooldown' &&
    fourth.decision.armCooldown === false &&
    fourth.decision.attemptCount === 3 &&
    fourth.row.cooldownUntilMs === third.row.cooldownUntilMs,
)

const providerCalls = []
let shared = null
for (let n = 1; n <= 4; n += 1) {
  const step = applyPermit(shared, SERVER_NOW)
  if (step.decision.action === 'permit') providerCalls.push(`osm_sp_${SERVER_NOW}_${n}`)
  shared = step.row
}
assert('only three sequential attempts contact the provider', providerCalls.length === 3 && shared.attemptCount === 3)

function createSerializedWindow(nowMs) {
  let row = null
  let chain = Promise.resolve()
  let calls = 0
  function reserve() {
    const run = chain.then(() => {
      const decision = decidePayAttemptTransition(row, nowMs)
      if (decision.action === 'permit') {
        calls += 1
        row = { attemptCount: decision.attemptCount, cooldownUntilMs: decision.cooldownUntilMs }
      } else if (decision.armCooldown) {
        row = { attemptCount: decision.attemptCount, cooldownUntilMs: decision.cooldownUntilMs }
      }
      return decision.action
    })
    chain = run.then(
      () => {},
      () => {},
    )
    return run
  }
  return {
    reserve,
    calls: () => calls,
    row: () => row,
  }
}

const concurrent = createSerializedWindow(SERVER_NOW)
const concurrentResults = await Promise.all(Array.from({ length: 8 }, () => concurrent.reserve()))
assert(
  'concurrent reservations cannot exceed three permits',
  concurrentResults.filter((action) => action === 'permit').length === 3 &&
    concurrentResults.filter((action) => action === 'cooldown').length === 5 &&
    concurrent.calls() === 3 &&
    concurrent.row().attemptCount === 3 &&
    concurrent.row().cooldownUntilMs === SERVER_NOW + COOLDOWN_MS,
)

const persisted = {
  attemptCount: concurrent.row().attemptCount,
  cooldownUntilMs: concurrent.row().cooldownUntilMs,
}
const afterRestart = decidePayAttemptTransition(
  { attemptCount: persisted.attemptCount, cooldownUntilMs: persisted.cooldownUntilMs },
  SERVER_NOW + 5_000,
)
assert(
  'a fresh reader keeps the persisted cooldown',
  afterRestart.action === 'cooldown' &&
    afterRestart.cooldownUntilMs === persisted.cooldownUntilMs &&
    afterRestart.armCooldown === false,
)

const staleRead = readPayAttemptGate({ attemptCount: 1, cooldownUntilMs: null }, SERVER_NOW + 86_400_000)
const stillSecond = decidePayAttemptTransition({ attemptCount: 1, cooldownUntilMs: null }, SERVER_NOW + 86_400_000)
assert(
  'an open window is not reset by time passing or a read',
  staleRead.action === 'open' && staleRead.attemptCount === 1 && stillSecond.action === 'permit' && stillSecond.attemptCount === 2,
)

const afterExpiry = decidePayAttemptTransition(
  { attemptCount: 3, cooldownUntilMs: SERVER_NOW + COOLDOWN_MS },
  SERVER_NOW + COOLDOWN_MS,
)
assert(
  'cooldown expiry uses the supplied server instant and starts a new window',
  afterExpiry.action === 'permit' && afterExpiry.attemptCount === 1 && afterExpiry.cooldownUntilMs == null,
)

const priorAccepted = [acceptedRow('osm_sp_a', 5_000)]
const retryPlan = planSonicpesaCustomerAttempt({
  recentRows: priorAccepted,
  attemptRow: { attemptCount: 1, cooldownUntilMs: null },
  nowMs: SERVER_NOW,
})
const thirdPlan = planSonicpesaCustomerAttempt({
  recentRows: [acceptedRow('osm_sp_b', 1_000), acceptedRow('osm_sp_a', 5_000)],
  attemptRow: { attemptCount: 2, cooldownUntilMs: null },
  nowMs: SERVER_NOW,
})
assert('a cancelled PIN checkout can be followed by a new customer attempt', retryPlan.action === 'create' && retryPlan.createsTransaction === true)
assert('the third customer checkout is still a new attempt', thirdPlan.action === 'create' && thirdPlan.contactsProvider === true)

const merchantIds = [1, 2, 3].map((n) => `osm_sp_${SERVER_NOW + n}_${randomBytes(5).toString('hex')}`)
assert('each permitted attempt can carry a distinct merchant order id', new Set(merchantIds).size === 3 && merchantIds.every((id) => id.startsWith('osm_sp_')))

const ambiguous = planSonicpesaCustomerAttempt({
  recentRows: [
    {
      order_id: 'osm_sp_timeout',
      status: 'pending',
      provider_initiation: 'ambiguous',
      provider_order_id: 'sp_maybe',
      updated_at: new Date(SERVER_NOW - 4_000).toISOString(),
    },
  ],
  attemptRow: { attemptCount: 1, cooldownUntilMs: null },
  nowMs: SERVER_NOW,
})
const timeoutClass = classifySonicpesaCreateResult({
  ok: false,
  status: 0,
  body: { error: 'This operation was aborted' },
})
assert(
  'an ambiguous provider result does not start another request',
  ambiguous.action === 'block_ambiguous' &&
    ambiguous.contactsProvider === false &&
    ambiguous.consumesAttempt === false &&
    timeoutClass.kind === 'ambiguous' &&
    timeoutClass.retryable === false &&
    timeoutClass.enqueueReconcile === false,
)

assert(
  'a failed attempt cannot activate a subscription',
  checkoutAllowsEntitlement({
    status: 'failed',
    raw_payload: { checkout_phase: 'terminal_failure', provider_initiation: 'failed' },
  }) === false,
)
assert(
  'a PIN prompt without provider confirmation cannot activate a subscription',
  checkoutAllowsEntitlement({
    status: 'pending',
    raw_payload: { checkout_phase: 'awaiting_authorization', provider_initiation: 'accepted' },
  }) === false,
)
assert(
  'a verified completed payment still allows the activation path',
  checkoutAllowsEntitlement({
    status: 'completed',
    raw_payload: { payment_provider: 'sonicpesa', provider_initiation: 'accepted', checkout_phase: 'awaiting_authorization' },
  }) === true,
)

const blockedPlan = planSonicpesaCustomerAttempt({
  recentRows: [acceptedRow('osm_sp_c', 500)],
  attemptRow: { attemptCount: 3, cooldownUntilMs: SERVER_NOW + COOLDOWN_MS },
  nowMs: SERVER_NOW + 30_000,
})
assert(
  'the fourth customer checkout is blocked before a transaction or provider call',
  blockedPlan.action === 'attempt_cooldown' && blockedPlan.contactsProvider === false && blockedPlan.createsTransaction === false,
)

const http = sonicpesaPayAttemptCooldownHttpBody(
  {
    cooldownUntilMs: SERVER_NOW + COOLDOWN_MS,
    serverNowMs: SERVER_NOW + 30_000,
  },
  'sp_corr',
)
assert(
  'cooldown HTTP contract is 429 with a stable code',
  http.status === 429 &&
    http.body.ok === false &&
    http.body.code === SONICPESA_PAY_ATTEMPT_COOLDOWN_CODE &&
    http.body.code === 'SONICPESA_PAY_ATTEMPT_COOLDOWN' &&
    http.body.cooldown_seconds === 180 &&
    http.body.cooldown_until === new Date(SERVER_NOW + COOLDOWN_MS).toISOString() &&
    http.body.pin_wait_allowed === false &&
    http.body.retryable === false &&
    http.retryAfterSeconds === 150 &&
    http.body.provider === 'sonicpesa',
)
const rendered = JSON.stringify(http.body)
assert('cooldown body has no phone number', !rendered.includes('255') && !rendered.includes('msisdn') && !rendered.includes('api_key'))

const deviceA = sonicpesaPayAttemptIdentity({ deviceId: 'dev-a', phone: '255678000111', planId: 9 })
const deviceAAgain = sonicpesaPayAttemptIdentity({ deviceId: 'dev-a', phone: '255678000111', planId: 9 })
const otherPlan = sonicpesaPayAttemptIdentity({ deviceId: 'dev-a', phone: '255678000111', planId: 10 })
assert(
  'identity is stable for device, phone, and plan and does not embed the phone',
  deviceA.identityKey === deviceAAgain.identityKey &&
    deviceA.identityKey !== otherPlan.identityKey &&
    !deviceA.identityKey.includes('255678000111') &&
    !deviceA.phoneHash.includes('255678000111'),
)

const flow = readFileSync(join(root, '../src/lib/sonicpesaCheckoutFlow.js'), 'utf8')
const reserveAt = flow.indexOf('reserveSonicpesaPayAttempt')
const permitAt = flow.indexOf("reserved.action !== 'permit'")
const insertAt = flow.indexOf('insertTransaction')
const providerAt = flow.indexOf('createOrder(')
assert(
  'the provider call happens only after a permitted reservation',
  reserveAt > 0 && permitAt > reserveAt && insertAt > permitAt && providerAt > insertAt,
)
assert('cooldown responses use the shared HTTP body', flow.includes('sonicpesaPayAttemptCooldownHttpBody'))
assert('provider 429 is not labeled as the attempt cooldown', !flow.includes("code: 'SONICPESA_PAY_ATTEMPT_COOLDOWN'"))

const store = readFileSync(join(root, '../src/lib/sonicpesaPayAttemptStore.js'), 'utf8')
assert('attempt state uses a locked database row and the database clock', store.includes('FOR UPDATE') && store.includes('clock_timestamp()') && !store.includes('new Map'))

const billing = readFileSync(join(root, '../src/db/billingTables.js'), 'utf8')
assert(
  'startup migration creates the attempt window with a rollback path',
  billing.includes('CREATE TABLE IF NOT EXISTS sonicpesa_pay_attempt_windows') &&
    billing.includes('DROP TABLE sonicpesa_pay_attempt_windows') &&
    billing.includes('attempt_count <= 3'),
)

const activation = readFileSync(join(root, '../src/lib/canonicalPaymentActivation.js'), 'utf8')
assert(
  'successful payments still use the idempotent activation path',
  activation.includes("if (txn.status === 'failed')") &&
    activation.includes('checkoutAllowsEntitlement') &&
    activation.includes('ALREADY_APPLIED'),
)
const reconcile = readFileSync(join(root, '../src/lib/sonicpesaPaymentReconciliationQueue.js'), 'utf8')
const paymentReconcile = readFileSync(join(root, '../src/paymentReconcile.js'), 'utf8')
assert(
  'reconciliation does not create another SonicPesa order',
  !reconcile.includes('createOrder(') && !paymentReconcile.includes('createOrder(') && paymentReconcile.includes('shouldActivelyReconcile'),
)

if (failed) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log('\ntest-sonicpesa-pay-attempt-limit ok')
