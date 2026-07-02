#!/usr/bin/env node
/**
 * Verify phone subscription ownership guard (production VPS + Render API parity).
 *
 * Uses read-only audit probe first; only calls create-order when probe expects block (409).
 *
 *   node server/scripts/verify-phone-subscription-guard.mjs
 *   VPS_API=https://api.osmanitv.com RENDER_API=https://osmani-admin-api.onrender.com node server/scripts/verify-phone-subscription-guard.mjs
 */
import crypto from 'node:crypto'

const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/$/, '')
const RENDER = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const TOKEN = String(process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '3030').trim()
/** Phone with a known status=active subscription on DEVICE_A (production-safe read-only default). */
const INVESTIGATE_PHONE = String(process.env.INVESTIGATE_PHONE || '255653271322').trim()
const DEVICE_A = String(
  process.env.DEVICE_A || '21440aac457904c4c4d46d8831e76972d5e6f6038f183ad44a17c275573f1bd8',
).trim()
const DEVICE_B = String(process.env.DEVICE_B || `verify-guard-b-${crypto.randomBytes(4).toString('hex')}`).trim()
const CODE = 'PHONE_ALREADY_HAS_ACTIVE_SUBSCRIPTION'

const report = { time: new Date().toISOString(), pass: true, apis: {} }

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
  const out = { base, commit: null, audit: null, block: null }
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

  const activeCount = audit.body.active_devices?.length ?? 0
  pass(`${label}-audit`, `${activeCount} active device(s)`)
  const probe = audit.body.probe_assessment
  if (probe?.allowed === false && probe?.reason === CODE) {
    pass(`${label}-probe`, `Device B blocked (${CODE})`)
    for (const k of ['existing_device_id', 'existing_expiry', 'remaining_days', 'message_sw']) {
      if (probe[k] == null && k !== 'remaining_days') {
        fail(`${label}-probe-fields`, `missing ${k}`)
      }
    }
    if (probe.existing_package != null) {
      pass(`${label}-probe-fields`, `existing_package=${probe.existing_package}`)
    }
  } else if (activeCount === 0) {
    fail(`${label}-probe`, `no active subscription for test phone ${INVESTIGATE_PHONE}`)
    return out
  } else {
    fail(`${label}-probe`, `expected block ${CODE}, got ${probe?.reason}`)
    return out
  }

  const probeDevice = `verify-guard-${label}-${crypto.randomBytes(3).toString('hex')}`
  const block = await jsonFetch(base, '/api/payments/sonicpesa/create-order', {
    method: 'POST',
    body: JSON.stringify({ deviceId: probeDevice, planId: 3, phone: INVESTIGATE_PHONE }),
  })
  out.block = { status: block.res.status, body: block.body }

  if (block.res.status === 409 && block.body?.code === CODE) {
    pass(`${label}-prePayment`, `sonicpesa/create-order 409 ${CODE}`)
    for (const k of ['existing_device_id', 'existing_expiry', 'remaining_days', 'message_sw']) {
      if (block.body[k] == null && k !== 'remaining_days') {
        fail(`${label}-fields`, `missing ${k}`)
      }
    }
    if (block.body.existing_device_id) {
      pass(`${label}-fields`, `existing_device_id=${String(block.body.existing_device_id).slice(0, 16)}…`)
    }
  } else if (block.res.status === 503 || block.res.status === 404) {
    const block2 = await jsonFetch(base, '/api/payments/create-payment', {
      method: 'POST',
      body: JSON.stringify({ deviceId: probeDevice, planId: 3, phone: INVESTIGATE_PHONE }),
    })
    out.block.fallback = { status: block2.res.status, body: block2.body }
    if (block2.res.status === 409 && block2.body?.code === CODE) {
      pass(`${label}-prePayment`, `create-payment 409 ${CODE}`)
    } else {
      fail(`${label}-prePayment`, `expected 409 ${CODE}, got ${block2.res.status}`)
    }
  } else {
    fail(`${label}-prePayment`, `expected 409 ${CODE}, got ${block.res.status}`)
  }

  return out
}

async function main() {
  console.log('=== Phone subscription guard verification ===')
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
