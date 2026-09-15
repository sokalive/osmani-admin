#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  AUDIT_REFERENCE_MS,
  CLASSIFICATION,
} from '../src/lib/historicalEntitlementCorrection.js'
import { replayStackedExpiryFromEvents } from '../src/lib/subscriptionExpiryAudit.js'
import { eatMidnightUtcIso } from '../src/lib/subscriptionStacking.js'

assert.equal(AUDIT_REFERENCE_MS, Date.parse('2026-09-14T21:00:00.000Z'))

const t0 = Date.UTC(2026, 8, 1, 10, 0, 0)
const { expectedExpiresAt } = replayStackedExpiryFromEvents([
  { atMs: t0, durationDays: 8, kind: 'payment', ref: 'o1' },
])
assert.equal(expectedExpiresAt, eatMidnightUtcIso(2026, 9, 9))

const activeRenewal = replayStackedExpiryFromEvents([
  { atMs: t0, durationDays: 8, kind: 'payment', ref: 'o1' },
  { atMs: Date.UTC(2026, 8, 5, 10, 0, 0), durationDays: 30, kind: 'payment', ref: 'o2' },
])
assert.equal(activeRenewal.expectedExpiresAt, eatMidnightUtcIso(2026, 9, 9))
assert.equal(activeRenewal.steps[1].preserved_existing, true)

assert.equal(CLASSIFICATION.EXPIRED, 'EXPIRED')
console.log('PASS historical-entitlement-correction unit checks')
