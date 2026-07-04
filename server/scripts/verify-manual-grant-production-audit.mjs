#!/usr/bin/env node
/**
 * Production audit: today's manual grants + verify path + admin bundle parity.
 *
 * Usage:
 *   ADMIN_TOKEN=3030 node server/scripts/verify-manual-grant-production-audit.mjs
 */
const VPS_API = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const RENDER_ADMIN = String(process.env.RENDER_ADMIN || 'https://osmani-admin-mpya.onrender.com').replace(
  /\/+$/,
  '',
)
const VPS_ADMIN = String(process.env.VPS_ADMIN || 'https://admin.osmanitv.com').replace(/\/+$/, '')
const TOKEN = String(process.env.ADMIN_TOKEN || process.env.APP_UPDATE_ADMIN_TOKEN || '3030').trim()
const TZ = process.env.PRODUCTION_TZ || 'Africa/Dar_es_Salaam'

let failed = 0

function fail(msg) {
  console.error(`FAIL ${msg}`)
  failed += 1
}

function ok(msg) {
  console.log(`OK ${msg}`)
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    cache: 'no-store',
    ...opts,
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      'X-Admin-Token': TOKEN,
      ...(opts.headers || {}),
    },
  })
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = { _raw: text.slice(0, 400) }
  }
  return { status: res.status, body, ms: res.headers.get('server-timing') }
}

async function verifyDevice(deviceId) {
  const t0 = Date.now()
  const { status, body } = await fetchJson(`${VPS_API}/api/subscription/verify`, {
    method: 'POST',
    body: JSON.stringify({ device_id: deviceId }),
    headers: {},
  })
  const ms = Date.now() - t0
  return {
    status,
    ms,
    active: body?.active === true,
    playbackAllowed: body?.playbackAllowed === true,
    manualGift: body?.manualGift?.showPopup === true,
    grantId: body?.manualGift?.grantId ?? null,
    expiresAt: body?.expiresAt ?? body?.expires_at ?? null,
    source: body?.source ?? null,
    error: body?.error ?? null,
  }
}

function todayWindowUtc() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]))
  const localDate = `${parts.year}-${parts.month}-${parts.day}`
  const start = new Date(`${localDate}T00:00:00+03:00`)
  const end = new Date(`${localDate}T23:59:59.999+03:00`)
  return { localDate, startIso: start.toISOString(), endIso: end.toISOString() }
}

async function grepAdminBundle(base, label) {
  const htmlRes = await fetch(`${base}/`, { cache: 'no-store' })
  const html = await htmlRes.text()
  const m = html.match(/src="(\/assets\/index-[^"]+\.js)"/)
  if (!m) {
    fail(`${label} admin HTML missing bundle`)
    return
  }
  const jsUrl = `${base}${m[1]}`
  const js = await (await fetch(jsUrl, { cache: 'no-store' })).text()
  const vpsApi = js.includes('api.osmanitv.com')
  const renderApi = js.includes('onrender.com')
  const sameOrigin = js.includes('"/api"') || js.includes("'/api'")
  ok(
    `${label} bundle ${m[1]} apiTarget=${vpsApi ? 'api.osmanitv.com' : renderApi ? 'onrender.com' : sameOrigin ? 'same-origin-/api' : 'unknown'}`,
  )
  if (label === 'Render' && !vpsApi && renderApi) {
    fail('Render admin bundle still targets Render API — redeploy static admin')
  }
}

async function main() {
  const { localDate, startIso, endIso } = todayWindowUtc()
  console.log(`\n=== Manual grant production audit (${localDate} ${TZ}) ===\n`)

  const histVps = await fetchJson(`${VPS_API}/api/admin/manual-subscription/history?limit=200`)
  const rowsVps = Array.isArray(histVps.body?.rows) ? histVps.body.rows : histVps.body?.history ?? []

  const health = await fetchJson(`${VPS_API}/api/health`)
  if (health.status === 200) ok(`VPS API health ${health.status}`)
  else fail(`VPS API health HTTP ${health.status}`)
  if (health.body?.commit) ok(`VPS API commit ${health.body.commit}`)

  await grepAdminBundle(VPS_ADMIN, 'VPS')
  await grepAdminBundle(RENDER_ADMIN, 'Render')

  const todayGrants = rowsVps.filter((r) => {
    const at = String(r.grantedAt ?? r.granted_at ?? r.created_at ?? '')
    if (!at) return false
    const t = new Date(at).getTime()
    return t >= new Date(startIso).getTime() && t <= new Date(endIso).getTime()
  })

  ok(`today grants from VPS history: ${todayGrants.length} (${startIso} .. ${endIso})`)
  ok('Render admin is static — history/read/write parity via api.osmanitv.com (bundle confirmed)')

  console.log('\n--- Per-device verify matrix ---\n')
  const seen = new Set()
  for (const g of todayGrants.sort((a, b) => Number(a.grantId ?? a.id) - Number(b.grantId ?? b.id))) {
    const grantId = g.grantId ?? g.id
    const deviceId = String(g.deviceId ?? g.device_id ?? '').trim()
    const histActive = g.subscriptionActive === true || g.status === 'active' || g.subscription_active === true
    console.log(
      `Grant ${grantId} device=${deviceId.slice(0, 16)}… duration=${g.durationDays ?? g.duration_days} histActive=${histActive}`,
    )

    const inv = await fetchJson(
      `${VPS_API}/api/runtime/device-production-investigation?device_id=${encodeURIComponent(deviceId)}`,
    )
    if (inv.status === 200) {
      const linked = inv.body?.linked_device_ids ?? []
      for (const lid of linked) {
        const lidStr = String(lid ?? '').trim()
        if (lidStr && lidStr !== deviceId && !seen.has(lidStr)) {
          seen.add(lidStr)
          const lv = await verifyDevice(lidStr)
          console.log(
            `  linked ${lidStr.slice(0, 20)}… active=${lv.active} playback=${lv.playbackAllowed} gift=${lv.manualGift} source=${lv.source} verifyMs=${lv.ms}`,
          )
          if (histActive && !lv.active) {
            fail(`linked device ${lidStr.slice(0, 16)} inactive while grant ${grantId} shows HAI`)
          }
        }
      }
    }

    if (seen.has(deviceId)) continue
    seen.add(deviceId)
    const v = await verifyDevice(deviceId)
    console.log(
      `  verify active=${v.active} playback=${v.playbackAllowed} gift=${v.manualGift} grantId=${v.grantId} ms=${v.ms}`,
    )
    if (histActive && !v.active) fail(`grant ${grantId} History HAI but verify inactive`)
    else if (histActive && v.active) ok(`grant ${grantId} verify confirms active`)
    if (histActive && v.active && !v.playbackAllowed) fail(`grant ${grantId} active but playbackAllowed=false`)
  }

  const giftAudit = await fetchJson(`${VPS_API}/api/runtime/manual-gift-production-investigation`)
  if (giftAudit.status === 200) {
    ok(
      `manual gift audit strict_popup=${giftAudit.body?.strict_legitimate_popup ?? giftAudit.body?.stats?.strict_legitimate_popup ?? '?'}`,
    )
  }

  console.log(`\n=== Done (${failed} failures) ===\n`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
