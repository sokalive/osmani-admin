#!/usr/bin/env node
/**
 * Verify manual gift popup only appears for legitimate pending manual grants.
 *
 * Usage:
 *   node scripts/verify-manual-gift-popup.mjs
 *   VPS_API=https://api.osmanitv.com ADMIN_TOKEN=3030 node scripts/verify-manual-gift-popup.mjs
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
  return { status: res.status, body }
}

async function verifyRecoverNoManualGift(base, label) {
  const res = await fetchJson(base, '/api/subscription/recover', {
    method: 'POST',
    body: JSON.stringify({ device_id: 'verify_no_gift_recover_probe', fingerprint: 'probe-fp-no-gift' }),
  })
  if (res.body?.manualGift != null) {
    fail(`${label} /subscription/recover must not return manualGift`)
  } else {
    ok(`${label} recover response has no manualGift`)
  }
}

async function verifyDatabaseReport(base, label) {
  const rep = await fetchJson(base, '/api/runtime/manual-gift-database-report')
  if (rep.status !== 200 || rep.body?.ok !== true) {
    fail(`${label} manual-gift-database-report HTTP ${rep.status}`)
    return null
  }
  const stats = rep.body.stats ?? {}
  ok(
    `${label} SQL stats pending=${stats.pending_unacked_total} strict=${stats.strict_legitimate_popup} stale=${stats.stale_false_positive_grants}`,
  )
  return stats
}

async function verifyDeviceCases(base, label, hist) {
  const rows = Array.isArray(hist?.rows) ? hist.rows : []
  if (rows.length === 0) {
    ok(`${label} skip device case probes — no grant history`)
    return
  }

  const paidCandidate = rows.find(
    (r) => r.subscriptionActive && r.deviceId && !String(r.deviceId).startsWith('verify_'),
  )
  if (paidCandidate?.deviceId) {
    const v = await fetchJson(base, '/api/subscription/verify', {
      method: 'POST',
      body: JSON.stringify({ device_id: paidCandidate.deviceId }),
    })
    const subTxn = String(v.body?.transaction_id ?? v.body?.transactionId ?? '')
    const gift = v.body?.manualGift
    if (subTxn && !subTxn.startsWith('manual_grant:') && gift?.showPopup === true) {
      fail(`${label} paid/non-manual device ${paidCandidate.deviceId} got manualGift popup`)
    } else if (subTxn && !subTxn.startsWith('manual_grant:')) {
      ok(`${label} non-manual active device verify manualGift=null`)
    }
  }

  const inactive = rows.find((r) => !r.subscriptionActive && r.deviceId)
  if (inactive?.deviceId) {
    const v = await fetchJson(base, '/api/subscription/verify', {
      method: 'POST',
      body: JSON.stringify({ device_id: inactive.deviceId }),
    })
    if (v.body?.manualGift?.showPopup === true) {
      fail(`${label} inactive device ${inactive.deviceId} got manualGift popup`)
    } else {
      ok(`${label} inactive device verify manualGift=null`)
    }
  }

  const manualActive = rows.find((r) => r.subscriptionActive && r.deviceId)
  if (manualActive?.deviceId) {
    const v = await fetchJson(base, '/api/subscription/verify', {
      method: 'POST',
      body: JSON.stringify({ device_id: manualActive.deviceId }),
    })
    const gift = v.body?.manualGift
    if (gift?.showPopup === true) {
      if (gift.grantId == null || !gift.nonce) fail(`${label} manualGift missing grantId/nonce`)
      else ok(`${label} manualGift payload shape valid when present`)
    } else {
      ok(`${label} active device without pending grant has manualGift=null`)
    }
  }
}

async function verifyBase(base, label) {
  const health = await fetchJson(base, '/api/health')
  if (health.status !== 200) {
    fail(`${label} health HTTP ${health.status}`)
    return null
  }
  ok(`${label} health commit=${health.body?.commit ?? 'unknown'}`)

  const stats = await verifyDatabaseReport(base, label)
  await verifyRecoverNoManualGift(base, label)

  const hist = await fetchJson(base, '/api/admin/manual-subscription/history?limit=80')
  if (hist.status !== 200) fail(`${label} history HTTP ${hist.status}`)
  else await verifyDeviceCases(base, label, hist.body)

  return { commit: health.body?.commit, stats }
}

async function main() {
  console.log('=== Manual Gift Popup Verification ===\n')
  const vps = await verifyBase(VPS, 'VPS')
  const render = await verifyBase(RENDER, 'Render')

  if (vps?.stats && Number(vps.stats.stale_false_positive_grants) > 0) {
    fail(`VPS still has ${vps.stats.stale_false_positive_grants} stale unacked grants — run manual-gift-repair`)
  }

  if (vps?.commit && render?.commit && vps.commit !== render.commit) {
    fail(`commit mismatch VPS=${vps.commit} Render=${render.commit}`)
  } else if (vps?.commit && render?.commit) {
    ok(`VPS and Render on same commit ${String(vps.commit).slice(0, 12)}`)
  }

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`)
    process.exit(1)
  }
  console.log('\nAll manual gift popup checks passed.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
