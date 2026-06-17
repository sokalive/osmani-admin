/**
 * ROOT/EMULATOR-only → Smart Monitor; FRIDA/APK/debugger/clone → block.
 */
import assert from 'node:assert/strict'
import {
  classifyAutomaticThreatEnforcement,
  computeRiskFromSignals,
  resolveStrictSecurityLevel,
  resolveSmartMonitorSecurityLevel,
} from '../src/lib/deviceSecurityStore.js'

const rootOnly = computeRiskFromSignals([{ risk_type: 'root_detected' }])
assert.equal(classifyAutomaticThreatEnforcement(rootOnly.flags), 'smart_monitor')
assert.equal(
  resolveStrictSecurityLevel({
    score: rootOnly.score,
    signals: rootOnly.signals,
    flags: rootOnly.flags,
    prev: null,
    adminStatus: 'monitoring',
  }),
  'warning',
  'root only must not block under strict mode',
)

const emuOnly = computeRiskFromSignals([{ risk_type: 'emulator_detected' }])
assert.equal(classifyAutomaticThreatEnforcement(emuOnly.flags), 'smart_monitor')

const rootEmu = computeRiskFromSignals([
  { risk_type: 'root_detected' },
  { risk_type: 'emulator_detected' },
])
assert.equal(classifyAutomaticThreatEnforcement(rootEmu.flags), 'smart_monitor')

const rootFrida = computeRiskFromSignals([
  { risk_type: 'root_detected' },
  { risk_type: 'frida_detected' },
])
assert.equal(classifyAutomaticThreatEnforcement(rootFrida.flags), 'block')
assert.equal(
  resolveStrictSecurityLevel({
    ...rootFrida,
    prev: null,
    adminStatus: 'monitoring',
  }),
  'blocked',
)

const fridaOnly = computeRiskFromSignals([{ risk_type: 'frida_detected' }])
assert.equal(classifyAutomaticThreatEnforcement(fridaOnly.flags), 'block')

const apkOnly = computeRiskFromSignals([{ risk_type: 'tampered_apk' }])
assert.equal(classifyAutomaticThreatEnforcement(apkOnly.flags), 'block')

const rootApk = computeRiskFromSignals([
  { risk_type: 'root_detected' },
  { risk_type: 'tampered_apk' },
])
assert.equal(classifyAutomaticThreatEnforcement(rootApk.flags), 'block')

const dbg = computeRiskFromSignals([{ risk_type: 'debugger_attached' }])
assert.equal(classifyAutomaticThreatEnforcement(dbg.flags), 'block')

const smartFridaOnly = resolveSmartMonitorSecurityLevel({ ...fridaOnly })
assert.equal(smartFridaOnly, 'warning', 'single frida below reblock threshold in smart monitor')

console.log('verify-root-emulator-policy: OK')
