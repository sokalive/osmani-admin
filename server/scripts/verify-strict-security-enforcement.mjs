/**
 * Verifies strict security enforcement (automatic protection mode).
 * Run: node scripts/verify-strict-security-enforcement.mjs
 */
import assert from 'node:assert/strict'
import {
  computeRiskFromSignals,
  hasDetectionSignals,
  resolveStrictSecurityLevel,
  resolveSmartMonitorSecurityLevel,
  levelFromScore,
} from '../src/lib/deviceSecurityStore.js'

const rootOnly = computeRiskFromSignals([{ risk_type: 'root_detected' }])
assert.equal(rootOnly.flags.rooted, true)
assert.ok(rootOnly.score >= 3)

const levelRoot = resolveStrictSecurityLevel({
  score: rootOnly.score,
  signals: rootOnly.signals,
  flags: rootOnly.flags,
  prev: null,
  adminStatus: 'monitoring',
})
assert.equal(levelRoot, 'warning', 'root only routes to smart monitor (warning), not block')

const emu = resolveStrictSecurityLevel({
  ...computeRiskFromSignals([{ risk_type: 'emulator_detected' }]),
  prev: null,
  adminStatus: 'monitoring',
})
assert.equal(emu, 'warning', 'emulator only routes to smart monitor')

const frida = resolveStrictSecurityLevel({
  ...computeRiskFromSignals([{ risk_type: 'frida_detected' }]),
  prev: null,
  adminStatus: 'monitoring',
})
assert.equal(frida, 'blocked', 'frida must block')

const clone = resolveStrictSecurityLevel({
  ...computeRiskFromSignals([{ risk_type: 'clone_detected' }]),
  prev: null,
  adminStatus: 'monitoring',
})
assert.equal(clone, 'blocked', 'clone must block')

const dbg = resolveStrictSecurityLevel({
  ...computeRiskFromSignals([{ risk_type: 'debugger_attached' }]),
  prev: null,
  adminStatus: 'monitoring',
})
assert.equal(dbg, 'blocked', 'debugger must block')

const apk = resolveStrictSecurityLevel({
  ...computeRiskFromSignals([{ risk_type: 'tampered_apk' }]),
  prev: null,
  adminStatus: 'monitoring',
})
assert.equal(apk, 'blocked', 'tampered apk must block')

const clean = resolveStrictSecurityLevel({
  score: 0,
  signals: [],
  flags: {
    rooted: false,
    emulator: false,
    clone_detected: false,
    debugger: false,
    frida: false,
    tampered_apk: false,
  },
  prev: null,
  adminStatus: 'monitoring',
})
assert.equal(clean, 'warning', 'no signals = warning')

const persisted = resolveStrictSecurityLevel({
  score: 0,
  signals: [],
  flags: {
    rooted: false,
    emulator: false,
    clone_detected: false,
    debugger: false,
    frida: false,
    tampered_apk: false,
  },
  prev: {
    security_level: 'blocked',
    admin_status: 'monitoring',
    risk_score: 3,
    rooted: true,
  },
  adminStatus: 'monitoring',
})
assert.equal(persisted, 'warning', 'persisted root-only re-evaluates to smart monitor path')

const whitelisted = resolveStrictSecurityLevel({
  ...rootOnly,
  prev: { security_level: 'blocked', admin_status: 'monitoring', risk_score: 3, rooted: true },
  adminStatus: 'whitelisted',
})
assert.notEqual(whitelisted, 'blocked', 'whitelist bypasses block level')

assert.equal(levelFromScore(99), 'blocked')
assert.equal(levelFromScore(0), 'warning')
assert.equal(hasDetectionSignals(rootOnly), true)

const smartRootOnly = resolveSmartMonitorSecurityLevel({
  score: rootOnly.score,
  signals: rootOnly.signals,
  flags: rootOnly.flags,
})
assert.equal(smartRootOnly, 'warning', 'single root must not re-block in smart monitor')

const smartFridaOnly = resolveSmartMonitorSecurityLevel({
  ...computeRiskFromSignals([{ risk_type: 'frida_detected' }]),
})
assert.equal(smartFridaOnly, 'warning', 'single frida below threshold must not re-block')

const smartCombo = resolveSmartMonitorSecurityLevel({
  ...computeRiskFromSignals([
    { risk_type: 'frida_detected' },
    { risk_type: 'tampered_apk' },
  ]),
})
assert.equal(smartCombo, 'blocked', 'frida + tampered must re-block in smart monitor')

const smartHighScore = resolveSmartMonitorSecurityLevel({
  ...computeRiskFromSignals([
    { risk_type: 'emulator_detected' },
    { risk_type: 'clone_detected' },
    { risk_type: 'debugger_attached' },
  ]),
})
assert.ok(smartHighScore === 'blocked', 'combined score >= threshold must re-block')

console.log('verify-strict-security-enforcement: OK')
