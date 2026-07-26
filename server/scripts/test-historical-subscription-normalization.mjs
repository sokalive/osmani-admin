#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { replayCanonicalEntitlement } from '../src/lib/historicalSubscriptionNormalization.js'

const checks = []
function check(name, fn) {
  fn()
  checks.push(name)
  console.log('PASS', name)
}

const day = 86_400_000
const at = Date.parse('2026-07-01T10:00:00.000Z')

check('single payment uses canonical midnight EAT', () => {
  const out = replayCanonicalEntitlement([
    {
      key: 'payment:one',
      ref: 'one',
      kind: 'payment',
      at_ms: at,
      purchased_at: new Date(at).toISOString(),
      duration_days: 3,
    },
  ])
  assert.equal(out.expected_expires_at, '2026-07-03T21:00:00.000Z')
  assert.equal(out.legitimate_stack_count, 0)
})

check('distinct overlap payment preserves all purchased days', () => {
  const out = replayCanonicalEntitlement([
    {
      key: 'payment:one',
      ref: 'one',
      kind: 'payment',
      at_ms: at,
      purchased_at: new Date(at).toISOString(),
      duration_days: 3,
    },
    {
      key: 'payment:two',
      ref: 'two',
      kind: 'payment',
      at_ms: at + day,
      purchased_at: new Date(at + day).toISOString(),
      duration_days: 7,
    },
  ])
  assert.equal(out.expected_expires_at, '2026-07-10T21:00:00.000Z')
  assert.equal(out.legitimate_stack_count, 1)
})

check('lapsed later payment starts a new canonical entitlement', () => {
  const out = replayCanonicalEntitlement([
    {
      key: 'payment:one',
      ref: 'one',
      kind: 'payment',
      at_ms: at,
      purchased_at: new Date(at).toISOString(),
      duration_days: 3,
    },
    {
      key: 'payment:two',
      ref: 'two',
      kind: 'payment',
      at_ms: at + 10 * day,
      purchased_at: new Date(at + 10 * day).toISOString(),
      duration_days: 3,
    },
  ])
  assert.equal(out.expected_expires_at, '2026-07-13T21:00:00.000Z')
  assert.equal(out.legitimate_stack_count, 0)
})

check('custom absolute grant is preserved', () => {
  const out = replayCanonicalEntitlement([
    {
      key: 'grant:1',
      ref: 'manual_grant:1',
      kind: 'manual_grant_custom',
      at_ms: at,
      purchased_at: new Date(at).toISOString(),
      duration_days: 30,
      absolute_ms: Date.parse('2026-08-15T12:00:00.000Z'),
    },
  ])
  assert.equal(out.expected_expires_at, '2026-08-15T12:00:00.000Z')
})

const source = fs.readFileSync(
  new URL('../src/lib/historicalSubscriptionNormalization.js', import.meta.url),
  'utf8',
)

check('live apply requires explicit confirmation', () => {
  assert.match(source, /if \(!confirm\)/)
})

check('rollback backup is written before subscription update', () => {
  const backupAt = source.indexOf('INSERT INTO subscription_normalization_backups')
  const updateAt = source.indexOf('UPDATE device_subscriptions', backupAt)
  assert.ok(backupAt >= 0 && updateAt > backupAt)
})

check('compare-and-swap protects concurrent payments', () => {
  assert.match(source, /AND expires_at = \$4::timestamptz/)
})

check('inactive normalization uses production-compatible pending status', () => {
  assert.match(source, /\? 'pending'\s*:\s*'active'/)
  assert.doesNotMatch(source, /targetStatus[\s\S]{0,120}\? 'expired'/)
})

check('payment and audit history are never deleted', () => {
  assert.doesNotMatch(source, /DELETE\s+FROM\s+(transactions|manual_subscription_grants|admin_)/i)
})

check('ambiguous evidence blocks all production writes', () => {
  assert.match(source, /corrections_blocked > 0/)
  assert.match(source, /Normalization stopped: ambiguous or missing evidence exists/)
})

console.log(`\n${checks.length}/${checks.length} passed`)
