#!/usr/bin/env node
/**
 * Verify payment-bound device ownership policy (production VPS + Render API parity).
 * Same phone on a different device must be allowed to create orders (no 409 block).
 *
 *   node server/scripts/verify-phone-subscription-guard.mjs
 */
import crypto from 'node:crypto'

const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/$/, '')
const RENDER = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const TOKEN = String(process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '3030').trim()
const INVESTIGATE_PHONE = String(process.env.INVESTIGATE_PHONE || '255653271322').trim()
const DEVICE_A = String(
  process.env.DEVICE_A || '21440aac457904c4c4d46d8831e76972d5e6f6038f183ad44a17c275573f1bd8',
).trim()
const DEVICE_B = String(process.env.DEVICE_B || `verify-guard-b-${crypto.randomBytes(4).toString('hex')}`).trim()
const ALLOWED_REASONS = new Set(['independent_device_payment', 'same_device_renewal', 'no_conflict', 'no_phone'])

const report = { time: new Date().toISOString(), pass: true, policy: 'payment_bound_to_originating_device', apis: {} }

function fail(section, msg) {
  report.pass = false
  console.error(`FAIL [${section}]`, msg)
}

function pass(section, msg) {
  console.log(`PASS [${section}]`, msg)
}

async function jsonFetch(base, path, opts = {}) {
  const res = await fetch(`${base}${path}`, {
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

async function verifyApi(label, base) {
  const out = { base, commit: null, audit: null, createOrder: null }
  const health = await jsonFetch(base, '/api/health')
  out.commit = health.body?.commit || null
  console.log(`\n[${label}] commit:`, String(out.commit || 'unknown').slice(0, 12))
  if (!health.res.ok) {
    fail(`${label}-health`, `HTTP ${health.res.status}`)
    return out
  }
  pass(`${label}-health`, 'reachable')

  const audit = await jsonFetch(
    base,
    `/api/runtime/phone-subscription-audit?phone=${encodeURIComponent(INVESTIGATE_PHONE)}&device_id=${encodeURIComponent(DEVICE_B)}`,
    { headers: { 'X-Admin-Token': TOKEN } },
  )
  out.audit = { status: audit.res.status, body: audit.body }
  if (audit.res.status === 404) {
    fail(`${label}-audit`, 'phone-subscription-audit not deployed (404)')
    return out
  }
  if (!audit.res.ok || audit.body?.ok !== true) {
    fail(`${label}-audit`, `HTTP ${audit.res.status}`)
    return out
  }

  if (audit.body.policy !== 'payment_bound_to_originating_device') {
    fail(`${label}-policy`, `expected payment_bound_to_originating_device, got ${audit.body.policy}`)
  } else {
    pass(`${label}-policy`, audit.body.policy)
  }

  const activeCount = audit.body.active_devices?.length ?? 0
  pass(`${label}-audit`, `${activeCount} active device(s)`)
  const probe = audit.body.probe_assessment
  if (activeCount === 0) {
    fail(`${label}-probe`, `no active subscription for test phone (need baseline Device A)`)
    return out
  }
  if (probe?.allowed === true && ALLOWED_REASONS.has(probe?.reason)) {
    pass(`${label}-probe`, `Device B allowed (${probe.reason})`)
  } else {
    fail(`${label}-probe`, `expected allowed independent_device_payment, got allowed=${probe?.allowed} reason=${probe?.reason}`)
    return out
  }

  const probeDevice = `verify-guard-${label}-${crypto.randomBytes(3).toString('hex')}`
  const create = await jsonFetch(base, '/api/payments/sonicpesa/create-order', {
    method: 'POST',
    body: JSON.stringify({ deviceId: probeDevice, planId: 3, phone: INVESTIGATE_PHONE }),
  })
  out.createOrder = { status: create.res.status, body: create.body }

  if (create.res.status === 200 || create.res.status === 202) {
    pass(`${label}-createOrder`, `sonicpesa/create-order accepted (${create.res.status})`)
  } else if (create.res.status === 503) {
    const fallback = await jsonFetch(base, '/api/payments/create-payment', {
      method: 'POST',
      body: JSON.stringify({ deviceId: probeDevice, planId: 3, phone: INVESTIGATE_PHONE }),
    })
    out.createOrder.fallback = { status: fallback.res.status, body: fallback.body }
    if (fallback.res.status === 200 || fallback.res.status === 202) {
      pass(`${label}-createOrder`, `create-payment accepted (${fallback.res.status})`)
    } else if (fallback.res.status === 409) {
      fail(`${label}-createOrder`, `still blocked 409 ${fallback.body?.code}`)
    } else {
      fail(`${label}-createOrder`, `unexpected ${fallback.res.status}`)
    }
  } else if (create.res.status === 409) {
    fail(`${label}-createOrder`, `blocked 409 ${create.body?.code} — phone must not block cross-device`)
  } else {
    fail(`${label}-createOrder`, `unexpected HTTP ${create.res.status}`)
  }

  return out
}

async function main() {
  console.log('=== Payment-bound device ownership verification ===')
  console.log('Test phone:', INVESTIGATE_PHONE)
  console.log('Owner device A:', DEVICE_A.slice(0, 20) + (DEVICE_A.length > 20 ? '…' : ''))
  console.log('Probe device B:', DEVICE_B.slice(0, 24) + (DEVICE_B.length > 24 ? '…' : ''))

  report.apis.vps = await verifyApi('VPS', VPS)
  report.apis.render = await verifyApi('Render', RENDER)

  const a = await jsonFetch(VPS, `/api/subscription-status?device_id=${encodeURIComponent(DEVICE_A)}`)
  const aActive = a.body?.active === true || a.body?.status === 'active'
  if (aActive) pass('deviceA', `${DEVICE_A.slice(0, 16)}… active`)
  else fail('deviceA', `${DEVICE_A.slice(0, 16)}… not active`)

  console.log('\n=== SUMMARY ===')
  console.log(JSON.stringify(report, null, 2))
  console.log(report.pass ? '\nOVERALL: PASS' : '\nOVERALL: FAIL')
  process.exit(report.pass ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
