#!/usr/bin/env node
import assert from 'node:assert/strict'
import { FORENSIC_OUTCOME } from '../src/lib/forensicAmbiguousReconciliation.js'
import { AUDIT_REFERENCE_MS } from '../src/lib/historicalEntitlementCorrection.js'

assert.equal(FORENSIC_OUTCOME.PROVEN_EXPIRED, 'PROVEN_EXPIRED')
assert.equal(AUDIT_REFERENCE_MS, Date.parse('2026-09-14T21:00:00.000Z'))
console.log('PASS forensic-ambiguous-reconciliation unit checks')
