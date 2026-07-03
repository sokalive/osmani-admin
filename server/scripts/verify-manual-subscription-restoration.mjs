#!/usr/bin/env node
/**
 * MFALME Manual Subscription restoration verification (read-only + gate probes).
 *
 * Usage:
 *   node scripts/verify-manual-subscription-restoration.mjs
 *   VPS_API=https://api.osmanitv.com RENDER_API=https://osmani-admin-api.onrender.com node scripts/verify-manual-subscription-restoration.mjs
 */
const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const RENDER = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/+$/, '')
const TOKEN = String(process.env.ADMIN_TOKEN || process.env.APP_UPDATE_ADMIN_TOKEN || '3030').trim()

let failed = 0

function fail(msg) {
  console.error(`FAIL ${msg}`)
  failed += 1
}

function ok(msg) {
  console.log(`OK ${msg}`)
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
  return { status: res.status, body, headers: res.headers }
}

async function verifyBase(base, label) {
  const health = await fetchJson(base, '/api/health')
  if (health.status !== 200) {
    fail(`${label} health HTTP ${health.status}`)
    return null
  }
  ok(`${label} health commit=${health.body?.commit ?? 'unknown'}`)

  const pinStatus = await fetchJson(base, '/api/admin/manual-subscription/pin-status')
  if (pinStatus.status !== 200) {
    fail(`${label} pin-status HTTP ${pinStatus.status}`)
  } else if (pinStatus.body?.usesSharedActionPassword !== true) {
    fail(`${label} pin-status missing usesSharedActionPassword`)
  } else {
    ok(`${label} pin-status MFALME shared-action password`)
  }

  const hist = await fetchJson(base, '/api/admin/manual-subscription/history?limit=5')
  if (hist.status !== 200 || !Array.isArray(hist.body?.rows)) {
    fail(`${label} history HTTP ${hist.status}`)
  } else {
    ok(`${label} history endpoint (${hist.body.rows.length} rows sample)`)
    const row = hist.body.rows[0]
    if (row) {
      for (const k of ['deviceId', 'durationDays', 'grantedAt']) {
        if (!(k in row)) fail(`${label} history row missing ${k}`)
      }
    }
  }

  const offerHist = await fetchJson(base, '/api/admin/offer-codes/history?limit=3')
  if (offerHist.status !== 200) {
    fail(`${label} offer-codes history HTTP ${offerHist.status}`)
  } else {
    ok(`${label} offer codes history`)
  }

  const plansRes = await fetchJson(base, '/api/plans')
  const plans = Array.isArray(plansRes.body) ? plansRes.body : []
  const plan = plans.find((p) => p?.isActive !== false && (p?.durationDays > 0 || p?.duration_days > 0))
  if (!plan) {
    ok(`${label} skip grant gate probes — no plans`)
    return health.body?.commit
  }

  const days = plan.durationDays || plan.duration_days || 7

  const noPin = await fetchJson(base, '/api/admin/manual-subscription/grant', {
    method: 'POST',
    body: JSON.stringify({ device_id: `rest_${Date.now()}`, duration_days: days, phone: '+255712345678' }),
  })
  if (noPin.status === 400 && String(noPin.body?.error || '').includes('PIN')) ok(`${label} grant requires PIN`)
  else fail(`${label} grant PIN gate (HTTP ${noPin.status})`)

  const noPhone = await fetchJson(base, '/api/admin/manual-subscription/grant', {
    method: 'POST',
    body: JSON.stringify({ device_id: `rest_${Date.now()}`, duration_days: days, pin: '3030' }),
  })
  if (noPhone.status === 400 && String(noPhone.body?.error || '').includes('phone')) {
    ok(`${label} grant requires phone (Osmani preserved)`)
  } else {
    fail(`${label} grant phone gate (HTTP ${noPhone.status})`)
  }

  const badPin = await fetchJson(base, '/api/admin/manual-subscription/grant', {
    method: 'POST',
    body: JSON.stringify({
      device_id: `rest_${Date.now()}`,
      duration_days: days,
      phone: '+255712345678',
      pin: 'invalid-probe',
    }),
  })
  if (badPin.status === 403) ok(`${label} grant rejects invalid PIN`)
  else fail(`${label} grant invalid PIN (HTTP ${badPin.status})`)

  return health.body?.commit
}

async function main() {
  console.log('=== Manual Subscription Restoration Verification ===\n')
  const vpsCommit = await verifyBase(VPS, 'VPS')
  const renderCommit = await verifyBase(RENDER, 'Render')

  if (vpsCommit && renderCommit && vpsCommit !== renderCommit) {
    fail(`commit mismatch VPS=${vpsCommit} Render=${renderCommit}`)
  } else if (vpsCommit && renderCommit) {
    ok(`VPS and Render on same commit ${vpsCommit}`)
  }

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`)
    process.exit(1)
  }
  console.log('\nAll manual subscription restoration checks passed.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
