#!/usr/bin/env node
/**
 * Verify phone subscription ownership guard (production or local API + optional DATABASE_URL).
 *
 *   node server/scripts/verify-phone-subscription-guard.mjs
 *   VPS_API=https://api.osmanitv.com ADMIN_TOKEN=3030 node server/scripts/verify-phone-subscription-guard.mjs
 *   INVESTIGATE_PHONE=255678089174 DEVICE_A=c172c09cedb35d39 DEVICE_B=abf0a53f6059e87b node server/scripts/verify-phone-subscription-guard.mjs
 */
import crypto from 'node:crypto'

const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/$/, '')
const API = `${VPS}/api`
const TOKEN = String(process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '3030').trim()
const INVESTIGATE_PHONE = String(process.env.INVESTIGATE_PHONE || '255678089174').trim()
const DEVICE_A = String(process.env.DEVICE_A || 'c172c09cedb35d39').trim()
const DEVICE_B = String(process.env.DEVICE_B || 'abf0a53f6059e87b').trim()

const report = {
  time: new Date().toISOString(),
  api: API,
  commit: null,
  health: null,
  phoneAudit: null,
  deviceA: null,
  deviceB: null,
  prePaymentBlock: null,
  pass: true,
}

function fail(section, msg) {
  report.pass = false
  console.error(`FAIL [${section}]`, msg)
}

function pass(section, msg) {
  console.log(`PASS [${section}]`, msg)
}

async function jsonFetch(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
    cache: 'no-store',
  })
  const body = await res.json().catch(() => null)
  return { res, body }
}

async function deviceStatus(deviceId) {
  const { res, body } = await jsonFetch(
    `${API}/subscription-status?device_id=${encodeURIComponent(deviceId)}`,
  )
  return { status: res.status, body }
}

async function main() {
  console.log('=== Phone subscription guard verification ===')
  console.log('API:', API)

  const health = await jsonFetch(`${API}/health`)
  report.health = health.body
  report.commit = health.body?.commit || health.body?.git_commit || null
  console.log('commit:', String(report.commit || 'unknown').slice(0, 12))
  if (!health.res.ok) {
    fail('health', `HTTP ${health.res.status}`)
  } else {
    pass('health', 'API reachable')
  }

  const audit = await jsonFetch(
    `${API}/runtime/phone-subscription-audit?phone=${encodeURIComponent(INVESTIGATE_PHONE)}&device_id=${encodeURIComponent(DEVICE_B)}`,
    { headers: { 'X-Admin-Token': TOKEN } },
  )
  report.phoneAudit = { status: audit.res.status, body: audit.body }
  if (audit.res.status === 404) {
    fail('audit', 'phone-subscription-audit endpoint not deployed yet (404)')
  } else if (!audit.res.ok || audit.body?.ok !== true) {
    fail('audit', `phone-subscription-audit HTTP ${audit.res.status}`)
  } else {
    pass('audit', `phone audit OK — ${audit.body.active_devices?.length ?? 0} active device(s)`)
    if (Array.isArray(audit.body.active_devices) && audit.body.active_devices.length > 1) {
      console.log(
        '  NOTE: legacy multiple active devices on same phone (pre-guard data):',
        audit.body.active_devices.map((d) => d.device_id?.slice(0, 16)).join(', '),
      )
    }
    const probe = audit.body.probe_assessment
    if (probe) {
      if (probe.allowed === false && probe.reason === 'phone_subscription_conflict') {
        pass('probe', `Device B (${DEVICE_B.slice(0, 12)}…) correctly blocked for payment`)
      } else if (probe.allowed === true && probe.reason === 'same_device_renewal') {
        pass('probe', 'Device has own active sub — renewal allowed')
      } else {
        console.log('  probe_assessment:', JSON.stringify(probe))
      }
    }
  }

  report.deviceA = await deviceStatus(DEVICE_A)
  report.deviceB = await deviceStatus(DEVICE_B)
  const aActive = report.deviceA.body?.active === true || report.deviceA.body?.status === 'active'
  const bActive = report.deviceB.body?.active === true || report.deviceB.body?.status === 'active'
  console.log(`Device A ${DEVICE_A}: active=${aActive}`)
  console.log(`Device B ${DEVICE_B}: active=${bActive}`)

  if (!aActive) {
    fail('deviceA', `${DEVICE_A} should remain active (valid customer)`)
  } else {
    pass('deviceA', `${DEVICE_A} still active`)
  }

  // Pre-payment block: try create-order on random device with known conflict phone (no provider charge if blocked before insert)
  const probeDevice = `verify-phone-guard-${crypto.randomBytes(4).toString('hex')}`
  const block = await jsonFetch(`${API}/payments/auraxpay/create-order`, {
    method: 'POST',
    body: JSON.stringify({
      deviceId: probeDevice,
      planId: 3,
      phone: INVESTIGATE_PHONE,
    }),
  })
  report.prePaymentBlock = { status: block.res.status, body: block.body }
  if (block.res.status === 409 && block.body?.code === 'phone_subscription_conflict') {
    pass('prePayment', 'create-order returns 409 phone_subscription_conflict')
  } else if (block.res.status === 404 || block.res.status === 503) {
    console.log('SKIP [prePayment] auraxpay not available — try sonicpesa path if needed')
    const block2 = await jsonFetch(`${API}/payments/create-payment`, {
      method: 'POST',
      body: JSON.stringify({
        deviceId: probeDevice,
        planId: 3,
        phone: INVESTIGATE_PHONE,
      }),
    })
    report.prePaymentBlock.fallback = { status: block2.res.status, body: block2.body }
    if (block2.res.status === 409 && block2.body?.code === 'phone_subscription_conflict') {
      pass('prePayment', 'create-payment returns 409 phone_subscription_conflict')
    } else if (audit.res.status === 404) {
      fail('prePayment', 'guard endpoint not deployed; cannot verify block')
    } else {
      fail('prePayment', `expected 409 conflict, got HTTP ${block2.res.status}`)
    }
  } else if (audit.res.status !== 404) {
    fail('prePayment', `expected 409 conflict, got HTTP ${block.res.status}`)
  }

  // Same-device renewal probe: paying device with active sub should be allowed (dry — only if audit shows same_device)
  if (audit.body?.probe_assessment && DEVICE_A) {
    const renewProbe = await jsonFetch(
      `${API}/runtime/phone-subscription-audit?phone=${encodeURIComponent(INVESTIGATE_PHONE)}&device_id=${encodeURIComponent(DEVICE_A)}`,
      { headers: { 'X-Admin-Token': TOKEN } },
    )
    const ra = renewProbe.body?.probe_assessment
    if (ra?.allowed === true && ra?.reason === 'same_device_renewal') {
      pass('renewal', 'Same phone + Device A allows renewal')
    } else if (renewProbe.res.ok) {
      console.log('  renewal probe:', JSON.stringify(ra))
    }
  }

  console.log('\n=== SUMMARY ===')
  console.log(JSON.stringify(report, null, 2))
  console.log(report.pass ? '\nOVERALL: PASS' : '\nOVERALL: FAIL')
  process.exit(report.pass ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
