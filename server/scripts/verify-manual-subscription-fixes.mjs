#!/usr/bin/env node
/**
 * Verify manual subscription fixes: custom dates, phone, PIN removal, auth refresh.
 *
 * Usage:
 *   node scripts/verify-manual-subscription-fixes.mjs
 *   VPS_API=https://api.osmanitv.com ADMIN_TOKEN=3030 node scripts/verify-manual-subscription-fixes.mjs
 */
import { grantCustomManualDeviceSubscription } from '../src/billingStore.js'
import { getPool } from '../src/db/pool.js'
import { replayStackedExpiryFromEvents } from '../src/lib/subscriptionExpiryAudit.js'

const BASE = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const RENDER_API = String(process.env.RENDER_API || 'https://osmani-admin-mpya.onrender.com').replace(
  /\/+$/,
  '',
)
const TOKEN = String(process.env.ADMIN_TOKEN || process.env.APP_UPDATE_ADMIN_TOKEN || '3030').trim()

let failed = 0

function fail(msg) {
  console.error(`FAIL ${msg}`)
  failed += 1
}

function ok(msg) {
  console.log(`OK ${msg}`)
}

function eatIso(y, mo, d, h, mi) {
  return new Date(Date.UTC(y, mo - 1, d, h - 3, mi, 0, 0)).toISOString()
}

async function fetchJson(base, path, opts = {}) {
  const res = await fetch(`${base}${path}`, {
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

function testCustomReplayAudit() {
  const start = eatIso(2026, 6, 30, 18, 21)
  const exp = eatIso(2026, 7, 10, 9, 30)
  const events = [
    {
      atMs: new Date(start).getTime(),
      absoluteExpiresAtMs: new Date(exp).getTime(),
      durationDays: 7,
      kind: 'manual_grant_custom',
      ref: 'manual_grant:1',
    },
  ]
  const { expectedExpiresAt } = replayStackedExpiryFromEvents(events)
  if (expectedExpiresAt !== exp) {
    fail(`custom replay expected ${exp} got ${expectedExpiresAt}`)
  } else {
    ok('custom expiry audit replay uses absolute dates')
  }
}

async function testLocalCustomGrantDates() {
  const pool = getPool()
  if (!pool) {
    ok('skip local DB custom grant — DATABASE_URL not set')
    return
  }
  const deviceId = `verify_custom_dates_${Date.now()}`
  const start = eatIso(2026, 6, 30, 18, 21)
  const exp = eatIso(2026, 7, 10, 9, 30)
  const plans = await pool.query(
    `SELECT id FROM plans WHERE deleted_at IS NULL AND is_active = true AND duration_days > 0 LIMIT 1`,
  )
  const planId = Number(plans.rows[0]?.id)
  if (!planId) {
    ok('skip local custom grant — no plan')
    return
  }

  const result = await grantCustomManualDeviceSubscription(deviceId, {
    planId,
    startedAt: start,
    expiresAt: exp,
    phone: '+255712345678',
    createdBy: 'verify_script',
  })

  const { rows } = await pool.query(
    `SELECT expires_at, started_at, transaction_id FROM device_subscriptions WHERE device_id = $1`,
    [deviceId],
  )
  const sub = rows[0]
  const subExp = sub?.expires_at instanceof Date ? sub.expires_at.toISOString() : String(sub?.expires_at)
  const subStart = sub?.started_at instanceof Date ? sub.started_at.toISOString() : String(sub?.started_at)

  if (subExp !== exp) fail(`device_subscriptions.expires_at ${subExp} !== ${exp}`)
  else ok('device_subscriptions stores custom expires_at')
  if (subStart !== start) fail(`device_subscriptions.started_at ${subStart} !== ${start}`)
  else ok('device_subscriptions stores custom started_at')
  if (result.expiresAt !== exp) fail(`grant result expiresAt mismatch`)
  else ok('grantCustom returns exact expiresAt')

  const { rows: txns } = await pool.query(
    `SELECT phone FROM transactions WHERE order_id = $1`,
    [`manual_grant:${result.grantId}`],
  )
  if (!txns[0]?.phone) fail('manual grant transaction missing phone')
  else ok('manual grant completed transaction has phone')
}

async function testPinAndPhoneRequired(base, label) {
  const plansRes = await fetchJson(base, '/api/plans')
  const plans = Array.isArray(plansRes.body) ? plansRes.body : []
  const plan = plans.find((p) => p?.isActive !== false && p?.durationDays > 0)
  if (!plan) {
    ok(`skip ${label} grant tests — no plans`)
    return
  }

  const pinStatus = await fetchJson(base, '/api/admin/manual-subscription/pin-status')
  if (pinStatus.status === 200 && pinStatus.body?.usesSharedActionPassword === true) {
    ok(`${label} pin-status usesSharedActionPassword`)
  } else {
    fail(`${label} pin-status missing usesSharedActionPassword`)
  }

  const missingPin = await fetchJson(base, '/api/admin/manual-subscription/grant', {
    method: 'POST',
    body: JSON.stringify({
      device_id: `verify_pin_${Date.now()}`,
      duration_days: plan.durationDays || plan.duration_days || 7,
      phone: '+255712345678',
    }),
  })
  if (missingPin.status === 400 && String(missingPin.body?.error || '').includes('PIN')) {
    ok(`${label} /grant requires PIN`)
  } else {
    fail(`${label} /grant missing PIN gate (HTTP ${missingPin.status})`)
  }

  const missingPhone = await fetchJson(base, '/api/admin/manual-subscription/grant', {
    method: 'POST',
    body: JSON.stringify({
      device_id: `verify_phone_${Date.now()}`,
      duration_days: plan.durationDays || plan.duration_days || 7,
      pin: '3030',
    }),
  })
  if (missingPhone.status === 400 && String(missingPhone.body?.error || '').includes('phone')) {
    ok(`${label} /grant requires phone (Osmani extension)`)
  } else {
    fail(`${label} /grant missing phone gate (HTTP ${missingPhone.status})`)
  }

  const badPin = await fetchJson(base, '/api/admin/manual-subscription/grant', {
    method: 'POST',
    body: JSON.stringify({
      device_id: `verify_bad_pin_${Date.now()}`,
      duration_days: plan.durationDays || plan.duration_days || 7,
      phone: '+255712345678',
      pin: 'wrong-pin-probe',
    }),
  })
  if (badPin.status === 403 && String(badPin.body?.error || '').includes('PIN')) {
    ok(`${label} /grant rejects invalid PIN`)
  } else {
    fail(`${label} /grant invalid PIN unexpected HTTP ${badPin.status}`)
  }

  const customBad = await fetchJson(base, '/api/admin/manual-subscription/grant-custom', {
    method: 'POST',
    body: JSON.stringify({
      device_id: `verify_custom_pin_${Date.now()}`,
      plan_id: plan.id,
      started_at: eatIso(2026, 8, 1, 10, 0),
      expires_at: eatIso(2026, 7, 1, 10, 0),
      phone: '+255712345678',
    }),
  })
  if (customBad.status === 400 && String(customBad.body?.error || '').includes('PIN')) {
    ok(`${label} grant-custom requires PIN`)
  } else if (customBad.status === 403) {
    ok(`${label} grant-custom PIN gate active`)
  } else if (customBad.status === 400 && String(customBad.body?.error || '').includes('later')) {
    ok(`${label} grant-custom reached date validation (PIN accepted or checked first)`)
  } else {
    fail(`${label} grant-custom unexpected HTTP ${customBad.status} ${JSON.stringify(customBad.body)}`)
  }
}

async function testHealth(base, label) {
  const { status, body } = await fetchJson(base, '/api/health')
  if (status === 200 && body?.ok !== false) ok(`${label} health OK`)
  else fail(`${label} health HTTP ${status}`)
}

async function main() {
  testCustomReplayAudit()
  await testLocalCustomGrantDates()
  await testHealth(BASE, 'VPS')
  await testPinAndPhoneRequired(BASE, 'VPS')
  await testHealth(RENDER_API, 'Render')
  await testPinAndPhoneRequired(RENDER_API, 'Render')

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`)
    process.exit(1)
  }
  console.log('\nAll manual subscription fix checks passed.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
