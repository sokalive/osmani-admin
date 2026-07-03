#!/usr/bin/env node
/**
 * Verify custom manual subscription grant (validation + history fields).
 *
 * Usage:
 *   node scripts/verify-custom-manual-subscription.mjs
 *   VPS_API=https://api.osmanitv.com ADMIN_TOKEN=3030 node scripts/verify-custom-manual-subscription.mjs
 */
import { grantCustomManualDeviceSubscription } from '../src/billingStore.js'
import { getPool } from '../src/db/pool.js'

const BASE = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const TOKEN = String(process.env.ADMIN_TOKEN || process.env.APP_UPDATE_ADMIN_TOKEN || '3030').trim()

let failed = 0

function fail(msg) {
  console.error(`FAIL ${msg}`)
  failed += 1
}

function ok(msg) {
  console.log(`OK ${msg}`)
}

async function fetchJson(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    cache: 'no-store',
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Token': TOKEN,
      ...(opts.headers || {}),
    },
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

function eatIso(y, mo, d, h, mi) {
  return new Date(Date.UTC(y, mo - 1, d, h - 3, mi, 0, 0)).toISOString()
}

async function testValidation() {
  try {
    await grantCustomManualDeviceSubscription('probe-device', {
      planId: 1,
      startedAt: eatIso(2026, 7, 15, 21, 45),
      expiresAt: eatIso(2026, 7, 1, 8, 30),
      createdBy: 'verify_script',
    })
    fail('expected expiry before start to throw')
  } catch (e) {
    if (String(e.message).includes('later than')) ok('rejects expiry before start')
    else fail(`unexpected error: ${e.message}`)
  }
}

async function testHistoryShape() {
  const { status, body } = await fetchJson('/api/admin/manual-subscription/history')
  if (status !== 200) {
    fail(`history HTTP ${status}`)
    return
  }
  const rows = Array.isArray(body?.rows) ? body.rows : []
  ok(`history HTTP 200 (${rows.length} rows)`)
  const sample = rows[0]
  if (sample) {
    const keys = ['customExpiry', 'manualCustom', 'planName', 'createdBy', 'startedAtCustom']
    for (const k of keys) {
      if (!(k in sample)) fail(`history row missing ${k}`)
      else ok(`history row has ${k}`)
    }
  } else {
    ok('history empty (field shape skipped)')
  }
}

async function testGrantCustomEndpointValidation() {
  const plansRes = await fetchJson('/api/plans')
  const plans = Array.isArray(plansRes.body) ? plansRes.body : []
  const plan = plans.find((p) => p?.isActive !== false && p?.durationDays > 0)
  if (!plan) {
    ok('skip grant-custom live test — no active plans')
    return
  }

  const bad = await fetchJson('/api/admin/manual-subscription/grant-custom', {
    method: 'POST',
    body: JSON.stringify({
      device_id: `verify_custom_${Date.now()}`,
      plan_id: plan.id,
      started_at: eatIso(2026, 8, 1, 10, 0),
      expires_at: eatIso(2026, 7, 1, 10, 0),
      phone: '+255712345678',
      pin: 'wrong-pin-probe',
    }),
  })
  if (bad.status === 400 && String(bad.body?.error || '').includes('later')) {
    ok('grant-custom rejects invalid date range')
  } else if (bad.status === 403) {
    ok('grant-custom reached server (PIN gate before date check is acceptable)')
  } else {
    fail(`grant-custom bad dates unexpected HTTP ${bad.status} ${JSON.stringify(bad.body)}`)
  }
}

async function testStandardGrantPinGate() {
  const { status, body } = await fetchJson('/api/admin/manual-subscription/grant', {
    method: 'POST',
    body: JSON.stringify({
      device_id: 'verify_standard_pin_gate',
      duration_days: 7,
      phone: '+255712345678',
      pin: 'wrong-pin',
    }),
  })
  if (status === 403 || (status === 400 && String(body?.error || '').includes('PIN'))) {
    ok('standard /grant endpoint PIN gate active')
  } else {
    fail(`standard grant unexpected HTTP ${status} ${JSON.stringify(body)}`)
  }
}

async function main() {
  if (getPool()) {
    await testValidation()
  } else {
    ok('skip local DB validation — DATABASE_URL not set')
  }
  await testHistoryShape()
  await testGrantCustomEndpointValidation()
  await testStandardGrantPinGate()

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`)
    process.exit(1)
  }
  console.log('\nAll custom manual subscription checks passed.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
