#!/usr/bin/env node
/**
 * Regression tests: paid renewal after expiry must not lose entitlement
 * due to missing completed_at / wrong credit clock / bad historical correction.
 */
import assert from 'node:assert/strict'
import {
  resolveTransactionCreditAtMs,
  TRANSACTION_BULK_BACKFILL_AT_ISO,
  transactionCreditAtSql,
} from '../src/lib/transactionCreditClock.js'
import { replayStackedExpiryFromEvents } from '../src/lib/subscriptionExpiryAudit.js'
import {
  computeMidnightEatExpiryIso,
  computeStackedExpiryIso,
  eatMidnightUtcIso,
} from '../src/lib/subscriptionStacking.js'
import {
  AUDIT_REFERENCE_MS,
  CLASSIFICATION,
} from '../src/lib/historicalEntitlementCorrection.js'

function assertEq(a, b, msg) {
  assert.equal(a, b, msg || `${a} !== ${b}`)
}

// --- 1) Credit clock: completed_at preferred ---
{
  const ms = resolveTransactionCreditAtMs({
    completed_at: '2026-09-15T08:00:55.000Z',
    created_at: '2026-08-08T08:10:29.000Z',
    updated_at: '2026-09-15T08:00:55.000Z',
    status: 'completed',
  })
  assertEq(ms, Date.parse('2026-09-15T08:00:55.000Z'), 'completed_at wins')
}

// --- 2) Credit clock: missing completed_at uses poll/webhook then safe updated_at ---
{
  const ms = resolveTransactionCreditAtMs({
    completed_at: null,
    created_at: '2026-08-08T08:10:29.000Z',
    updated_at: '2026-09-15T08:00:55.000Z',
    status: 'completed',
    raw_payload: { orderStatusPolledAt: '2026-09-15T08:00:50.000Z' },
  })
  assertEq(ms, Date.parse('2026-09-15T08:00:50.000Z'), 'poll stamp wins over created_at')
}

{
  const ms = resolveTransactionCreditAtMs({
    completed_at: null,
    created_at: '2026-08-08T08:10:29.000Z',
    updated_at: '2026-09-15T08:00:55.000Z',
    status: 'completed',
    raw_payload: {},
  })
  assertEq(ms, Date.parse('2026-09-15T08:00:55.000Z'), 'safe updated_at when delayed completion')
}

// --- 3) Credit clock: bulk backfill stamp must NOT become credit time ---
{
  const ms = resolveTransactionCreditAtMs({
    completed_at: null,
    created_at: '2026-06-01T10:00:00.000Z',
    updated_at: TRANSACTION_BULK_BACKFILL_AT_ISO,
    status: 'completed',
    raw_payload: {},
  })
  assertEq(ms, Date.parse('2026-06-01T10:00:00.000Z'), 'bulk stamp falls through to created_at')
}

// --- 4) SQL fragment exports ---
{
  const sql = transactionCreditAtSql('t')
  assert.ok(sql.includes('completed_at'), 'sql has completed_at')
  assert.ok(sql.includes('orderStatusPolledAt'), 'sql has poll stamp')
  assert.ok(sql.includes(TRANSACTION_BULK_BACKFILL_AT_ISO), 'sql guards bulk stamp')
}

// --- 5) Expired renewal: fresh midnight expiry from completion clock ---
{
  const created = Date.parse('2026-08-08T08:10:29.000Z')
  const completed = Date.parse('2026-09-15T08:00:55.000Z')
  const priorExpired = eatMidnightUtcIso(2026, 7, 13) // long expired
  const stack = computeStackedExpiryIso(priorExpired, 30, completed)
  assertEq(stack.expiry_policy, 'midnight_africa_dar_es_salaam')
  assertEq(stack.expiresAt, computeMidnightEatExpiryIso(30, completed))
  // Wrong clock (created_at) would produce past expiry before activation:
  const wrong = computeMidnightEatExpiryIso(30, created)
  assert.ok(Date.parse(wrong) < completed, 'created_at+30d is before completion')
  assert.ok(Date.parse(stack.expiresAt) > completed, 'correct clock yields future expiry')
}

// --- 6) Active subscriber renew: preserve existing ---
{
  const now = Date.UTC(2026, 8, 10, 12, 0, 0)
  const prev = eatMidnightUtcIso(2026, 9, 20)
  const stack = computeStackedExpiryIso(prev, 8, now)
  assertEq(stack.expiry_policy, 'preserve_existing_active')
  assertEq(stack.expiresAt, prev)
}

// --- 7) Delayed completion replay must use completion clock, not created_at ---
{
  const created = Date.parse('2026-08-08T08:10:29.000Z')
  const completed = Date.parse('2026-09-15T08:00:55.000Z')
  const wrongReplay = replayStackedExpiryFromEvents([
    { atMs: created, durationDays: 30, kind: 'payment', ref: 'osm_sp_old' },
  ])
  const rightReplay = replayStackedExpiryFromEvents([
    { atMs: completed, durationDays: 30, kind: 'payment', ref: 'osm_sp_old' },
  ])
  assert.ok(
    Date.parse(wrongReplay.expectedExpiresAt) < completed,
    'created_at credit destroys entitlement',
  )
  assert.ok(
    Date.parse(rightReplay.expectedExpiresAt) > completed,
    'completion credit preserves entitlement',
  )
  assertEq(rightReplay.expectedExpiresAt, computeMidnightEatExpiryIso(30, completed))
}

// --- 8) Multiple historical durations (snapshot) ---
for (const days of [3, 7, 8, 30, 60, 121, 365]) {
  const at = Date.UTC(2026, 8, 15, 10, 0, 0)
  const exp = computeMidnightEatExpiryIso(days, at)
  const replay = replayStackedExpiryFromEvents([
    { atMs: at, durationDays: days, kind: 'payment', ref: `d${days}` },
  ])
  assertEq(replay.expectedExpiresAt, exp, `duration ${days}`)
}

// --- 9) Midnight EAT boundary ---
{
  // 15 Sep 2026 21:30 UTC = 16 Sep 00:30 EAT → purchase day is 16 Sep
  const at = Date.UTC(2026, 8, 15, 21, 30, 0)
  const exp = computeMidnightEatExpiryIso(8, at)
  assertEq(exp, eatMidnightUtcIso(2026, 9, 24))
}

// --- 10) Same txn twice does not stack ---
{
  const at = Date.UTC(2026, 8, 15, 10, 0, 0)
  const once = replayStackedExpiryFromEvents([
    { atMs: at, durationDays: 8, kind: 'payment', ref: 'same' },
  ])
  const twice = replayStackedExpiryFromEvents([
    { atMs: at, durationDays: 8, kind: 'payment', ref: 'same' },
    { atMs: at + 1000, durationDays: 8, kind: 'payment', ref: 'same' },
  ])
  // Second payment while first still future → preserve
  assertEq(twice.steps[1].preserved_existing, true)
  assertEq(twice.expectedExpiresAt, once.expectedExpiresAt)
}

// --- 11) New txn after expiry extends from new clock ---
{
  const first = Date.UTC(2026, 6, 1, 10, 0, 0)
  const second = Date.UTC(2026, 8, 15, 10, 0, 0)
  const replay = replayStackedExpiryFromEvents([
    { atMs: first, durationDays: 7, kind: 'payment', ref: 'old' },
    { atMs: second, durationDays: 30, kind: 'payment', ref: 'new' },
  ])
  assertEq(replay.expectedExpiresAt, computeMidnightEatExpiryIso(30, second))
  assertEq(replay.steps[1].preserved_existing, false)
}

// --- 12) Impossible state: expires_at < started_at must not be proposed by correct clock ---
{
  const started = Date.parse('2026-09-15T08:00:55.000Z')
  const credit = resolveTransactionCreditAtMs({
    completed_at: null,
    created_at: '2026-08-08T08:10:29.000Z',
    updated_at: '2026-09-15T08:00:55.000Z',
    status: 'completed',
  })
  const expires = computeMidnightEatExpiryIso(30, Math.max(started, credit))
  assert.ok(Date.parse(expires) > started, 'restored expiry after started_at')
}

// --- 13) Classification constants still present ---
assertEq(CLASSIFICATION.EXPIRED, 'EXPIRED')
assert.ok(AUDIT_REFERENCE_MS > 0)

console.log('PASS paid-renewal-after-expiry regression suite')
