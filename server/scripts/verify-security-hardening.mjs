/**
 * Security hardening E2E verification.
 * Usage:
 *   node scripts/verify-security-hardening.mjs
 *   SECURITY_TEST_BASE_URL=https://api.osmanitv.com node scripts/verify-security-hardening.mjs
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
  computeAuthoritativeRiskFromSignals,
  mergePersistentFlags,
} from '../src/lib/securityRiskAuthority.js'
import {
  classifyAutomaticThreatEnforcement,
  computeRiskFromSignals,
  resolveStrictSecurityLevel,
} from '../src/lib/deviceSecurityStore.js'
import { buildEverColumnsUpdate, resolveTrustContext } from '../src/lib/securityTrustEngine.js'

const BASE = String(process.env.SECURITY_TEST_BASE_URL || 'http://127.0.0.1:3099').replace(/\/$/, '')
const USE_LIVE = Boolean(process.env.SECURITY_TEST_BASE_URL)

function deviceId(prefix) {
  return crypto.createHash('sha256').update(`${prefix}:${Date.now()}:${crypto.randomUUID()}`).digest('hex').slice(0, 32)
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, body: json }
}

console.log('==> Unit: authoritative scoring ignores client risk_score 0 on frida')
{
  const auth = computeAuthoritativeRiskFromSignals([{ risk_type: 'frida_detected', risk_score: 0 }])
  assert.equal(auth.ok, true)
  assert.equal(auth.score, 10)
  assert.equal(auth.score_mismatch, true)
  console.log('PASS  fake clean score → server score 10')
}

console.log('==> Unit: computeRiskFromSignals uses server weights')
{
  const r = computeRiskFromSignals([{ risk_type: 'frida_detected', risk_score: 0 }])
  assert.equal(r.score, 10)
  console.log('PASS  computeRiskFromSignals authoritative')
}

console.log('==> Unit: severe history preserved on clean report flags')
{
  const prev = { ever_frida: true, frida: true, highest_risk_score: 10 }
  const report = computeAuthoritativeRiskFromSignals([])
  const merged = mergePersistentFlags(prev, report.flags)
  assert.equal(merged.frida, true)
  const ever = buildEverColumnsUpdate(prev, report.flags, 0, false)
  assert.equal(ever.ever_frida, true)
  assert.equal(ever.ever_severe, true)
  console.log('PASS  severe flags persist after clean report')
}

console.log('==> Unit: smart monitor root/emulator unchanged')
{
  const root = computeRiskFromSignals([{ risk_type: 'root_detected' }])
  assert.equal(classifyAutomaticThreatEnforcement(root.flags), 'smart_monitor')
  const level = resolveStrictSecurityLevel({ ...root, prev: null, adminStatus: 'monitoring' })
  assert.equal(level, 'warning')
  console.log('PASS  smart monitor policy preserved')
}

console.log('==> Unit: trust context clean after severe → suspicious')
{
  const prev = { ever_severe: true, ever_frida: true, highest_risk_score: 10 }
  const ctx = resolveTrustContext(prev, {
    challengeValid: true,
    challengeMissing: false,
    reportScore: 0,
    reportHasSevere: false,
    reportFlags: {},
  })
  assert.equal(ctx.trust_state, 'suspicious')
  console.log('PASS  clean after severe → suspicious without attestation')
}

if (USE_LIVE) {
  console.log(`==> Live API tests against ${BASE}`)
  const dev = deviceId('hardening-live')

  const ch1 = await post('/api/runtime/security-challenge', { device_id: dev })
  assert.equal(ch1.status, 200, `challenge status ${ch1.status}`)
  assert.ok(ch1.body.nonce, 'challenge nonce')
  console.log('PASS  TEST challenge issued')

  const rep1 = await post('/api/runtime/security-report', {
    device_id: dev,
    security_nonce: ch1.body.nonce,
    signals: [{ risk_type: 'root_detected' }],
  })
  assert.equal(rep1.status, 200, JSON.stringify(rep1.body))
  assert.ok(rep1.body.server_calculated_score >= 3)
  console.log('PASS  TEST 1 legitimate report with challenge')

  const ch2 = await post('/api/runtime/security-challenge', { device_id: dev })
  const fake = await post('/api/runtime/security-report', {
    device_id: dev,
    security_nonce: ch2.body.nonce,
    signals: [{ risk_type: 'frida_detected', risk_score: 0 }],
  })
  assert.equal(fake.status, 200)
  assert.ok(fake.body.server_calculated_score >= 10)
  assert.notEqual(fake.body.risk_score, 0)
  console.log('PASS  TEST 2 fake clean score rejected for enforcement')

  const ch3 = await post('/api/runtime/security-challenge', { device_id: dev })
  const replay1 = await post('/api/runtime/security-report', {
    device_id: dev,
    security_nonce: ch3.body.nonce,
    signals: [],
  })
  assert.equal(replay1.status, 200)
  const replay2 = await post('/api/runtime/security-report', {
    device_id: dev,
    security_nonce: ch3.body.nonce,
    signals: [],
  })
  assert.equal(replay2.status, 403)
  assert.equal(replay2.body.code, 'nonce_replay')
  console.log('PASS  TEST 3 replay rejected')

  const ch4 = await post('/api/runtime/security-challenge', { device_id: deviceId('mismatch-a') })
  const devB = deviceId('mismatch-b')
  const mismatch = await post('/api/runtime/security-report', {
    device_id: devB,
    security_nonce: ch4.body.nonce,
    signals: [],
  })
  assert.equal(mismatch.status, 403)
  assert.equal(mismatch.body.code, 'device_mismatch')
  console.log('PASS  TEST 5 device mismatch rejected')

  const severeDev = deviceId('severe-clean')
  const chS = await post('/api/runtime/security-challenge', { device_id: severeDev })
  await post('/api/runtime/security-report', {
    device_id: severeDev,
    security_nonce: chS.body.nonce,
    signals: [{ risk_type: 'frida_detected' }],
  })
  const chC = await post('/api/runtime/security-challenge', { device_id: severeDev })
  const clean = await post('/api/runtime/security-report', {
    device_id: severeDev,
    security_nonce: chC.body.nonce,
    signals: [],
  })
  assert.equal(clean.status, 200)
  assert.equal(clean.body.ever_severe, true)
  assert.ok(clean.body.trust_state === 'suspicious' || clean.body.security_blocked)
  console.log('PASS  TEST 6 severe then fake clean preserves ever_severe')

  console.log('PASS  live API hardening tests')
} else {
  console.log('SKIP  live API tests (set SECURITY_TEST_BASE_URL for live run)')
  console.log('verify-security-hardening: OK (unit only)')
}
