#!/usr/bin/env node
/**
 * Canonical subscription expiry/activation contract tests (A–N).
 * Run: node server/scripts/test-subscription-expiry-contract.mjs
 */
import assert from 'node:assert/strict'
import {
  computeMidnightEatExpiryIso,
  computeStackedExpiryIso,
  eatMidnightUtcIso,
  SUBSCRIPTION_TZ,
} from '../src/lib/subscriptionStacking.js'
import {
  getCachedSubscriptionAccess,
  getStaleCachedSubscriptionAccess,
  setCachedSubscriptionAccess,
  invalidateSubscriptionAccessCache,
} from '../src/lib/subscriptionAccessCache.js'
import {
  buildSubscriptionVerifyUnavailableBody,
  isDbTimeoutOrPressureError,
  resolveVerifyErrorHttpOutcome,
} from '../src/lib/verifyDbResilience.js'
import { PoolSaturatedError } from '../src/lib/poolSaturation.js'
import { replayStackedExpiryFromEvents } from '../src/lib/subscriptionExpiryAudit.js'
import { mapOperationalSubscriptionRow } from '../src/lib/adminUsersList.js'
import { activeSubscriptionExistsHttpBody } from '../src/lib/activeSubscriptionPaymentGate.js'
import { ACTIVATION_STATE } from '../src/lib/canonicalPaymentActivation.js'

const results = []

function pass(name) {
  results.push({ name, ok: true })
  console.log(`PASS  ${name}`)
}

function fail(name, err) {
  results.push({ name, ok: false, error: String(err?.message || err) })
  console.error(`FAIL  ${name}:`, err?.message || err)
}

function check(name, fn) {
  try {
    fn()
    pass(name)
  } catch (e) {
    fail(name, e)
  }
}

// A. New purchase → midnight EAT boundary
check('A_new_purchase_midnight_eat', () => {
  const now = Date.UTC(2026, 6, 25, 8, 0, 0)
  const out = computeStackedExpiryIso(null, 7, now)
  assert.equal(out.expiresAt, eatMidnightUtcIso(2026, 8, 1))
  assert.equal(out.expiry_policy, 'midnight_africa_dar_es_salaam')
})

// B. 1-day plan boundary
check('B_one_day_plan', () => {
  const now = Date.UTC(2026, 6, 25, 19, 30, 0)
  const out = computeMidnightEatExpiryIso(1, now)
  assert.equal(out, eatMidnightUtcIso(2026, 7, 26))
})

// C. Multi-day plans
check('C_multi_day_plans', () => {
  const now = Date.UTC(2026, 7, 31, 12, 0, 0) // 31 Aug 2026 EAT afternoon
  for (const days of [8, 30, 60, 121]) {
    const out = computeMidnightEatExpiryIso(days, now)
    const again = computeStackedExpiryIso(null, days, now).expiresAt
    assert.equal(out, again, `${days}d consistent`)
  }
})

// D. Already active — preserve, no extension (activation path)
check('D_active_preserve_no_stack', () => {
  const now = Date.UTC(2026, 6, 25, 12, 0, 0)
  const prev = new Date(now + 10 * 86400000).toISOString()
  const out = computeStackedExpiryIso(prev, 7, now)
  assert.equal(out.expiresAt, prev)
  assert.equal(out.expiry_policy, 'preserve_existing_active')
})

// D2. 409 body shape for active subscription gate
check('D2_active_subscription_409_body', () => {
  const body = activeSubscriptionExistsHttpBody({
    deviceId: 'dev1',
    expiresAt: '2026-12-01T00:00:00.000Z',
    remainingDays: 5,
  })
  assert.equal(body.code, 'ACTIVE_SUBSCRIPTION_EXISTS')
  assert.equal(body.ok, false)
  assert.equal(body.newly_activated, false)
})

// E. Expired → fresh expiry from purchase date
check('E_expired_fresh_expiry', () => {
  const now = Date.UTC(2026, 6, 25, 12, 0, 0)
  const prev = new Date(now - 86400000).toISOString()
  const out = computeStackedExpiryIso(prev, 3, now)
  assert.equal(out.expiresAt, computeMidnightEatExpiryIso(3, now))
})

// F. Expired verify semantics (status active but expires_at passed → inactive)
check('F_expired_active_status_inactive', () => {
  const past = new Date(Date.now() - 86400000).toISOString()
  const row = mapOperationalSubscriptionRow({
    device_id: 'x'.repeat(64),
    status: 'active',
    started_at: past,
    expires_at: past,
    transaction_id: 'osm_sp_test',
    admin_revoked_at: null,
    provider: 'sonicpesa',
  })
  assert.equal(row.active, false)
  assert.equal(row.status, 'expired')
})

// G. Cache: ACTIVE + passed expires_at must NOT grant access
check('G_cache_expired_active_blocked', () => {
  const deviceId = 'contract_cache_expired'
  const past = new Date(Date.now() - 3600000).toISOString()
  setCachedSubscriptionAccess(
    deviceId,
    '',
    { status: 'active', active_now: true, expires_at: past, remaining_days: 99 },
    60000,
  )
  assert.equal(getCachedSubscriptionAccess(deviceId, ''), undefined)
  invalidateSubscriptionAccessCache(deviceId)
})

check('G2_stale_cache_never_restores', () => {
  assert.equal(getStaleCachedSubscriptionAccess('any', ''), undefined)
})

// H. DB failure must not become active:false
check('H_db_pressure_active_null', () => {
  const err = new PoolSaturatedError('pool_saturated')
  assert.ok(isDbTimeoutOrPressureError(err))
  const body = buildSubscriptionVerifyUnavailableBody(err)
  assert.equal(body.active, null)
  assert.notEqual(body.active, false)
  const outcome = resolveVerifyErrorHttpOutcome(err, null)
  assert.equal(outcome.status, 503)
  assert.notEqual(outcome.body.active, false)
})

// I. Duplicate webhook idempotency (static)
check('I_activation_already_applied_state', () => {
  assert.equal(ACTIVATION_STATE.ALREADY_APPLIED, 'ALREADY_APPLIED')
})

// J. Audit replay no-stack (concurrent activation math)
check('J_audit_replay_no_stack', () => {
  const t0 = Date.UTC(2026, 6, 1, 10, 0, 0)
  const t1 = Date.UTC(2026, 6, 5, 10, 0, 0)
  const first = computeMidnightEatExpiryIso(7, t0)
  const { expectedExpiresAt, steps } = replayStackedExpiryFromEvents([
    { atMs: t0, durationDays: 7, kind: 'payment', ref: 'o1' },
    { atMs: t1, durationDays: 7, kind: 'payment', ref: 'o2' },
  ])
  assert.equal(expectedExpiresAt, first)
  assert.equal(steps[1].preserved_existing, true)
  assert.equal(steps[1].stacked, false)
})

// K. Revoke classification
check('K_revoke_not_expired', () => {
  const past = new Date(Date.now() - 86400000).toISOString()
  const row = mapOperationalSubscriptionRow({
    device_id: 'y'.repeat(64),
    status: 'active',
    started_at: past,
    expires_at: past,
    transaction_id: 'osm_sp_test',
    admin_revoked_at: new Date().toISOString(),
    provider: 'sonicpesa',
  })
  assert.equal(row.status, 'revoked')
  assert.notEqual(row.status, 'expired')
})

// M. Admin active/expired classification
check('M_admin_active_future', () => {
  const future = new Date(Date.now() + 86400000).toISOString()
  const row = mapOperationalSubscriptionRow({
    device_id: 'z'.repeat(64),
    status: 'active',
    started_at: new Date().toISOString(),
    expires_at: future,
    transaction_id: 'osm_sp_test',
    admin_revoked_at: null,
    provider: 'sonicpesa',
  })
  assert.equal(row.status, 'active')
  assert.equal(row.active, true)
})

// N. Timezone Africa/Dar_es_Salaam midnight → UTC
check('N_timezone_eat_midnight_utc', () => {
  assert.equal(SUBSCRIPTION_TZ, 'Africa/Dar_es_Salaam')
  assert.equal(eatMidnightUtcIso(2026, 8, 1), '2026-07-31T21:00:00.000Z')
})

const failed = results.filter((r) => !r.ok)
console.log(`\n=== expiry contract tests: ${results.length - failed.length}/${results.length} passed ===`)
if (failed.length) {
  console.error(JSON.stringify(failed, null, 2))
  process.exit(1)
}
