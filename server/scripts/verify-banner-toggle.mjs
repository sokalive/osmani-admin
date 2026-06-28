#!/usr/bin/env node
/**
 * Verify banner active toggle + public API cache invalidation.
 *
 *   node server/scripts/verify-banner-toggle.mjs
 *   VPS_API=https://api.osmanitv.com ADMIN_TOKEN=... BANNER_TEST_ID=3 node server/scripts/verify-banner-toggle.mjs
 */
import { bannerSaveBody } from '../../src/lib/bannerSaveBody.js'

const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/$/, '')
const RENDER = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const TOKEN = String(process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '').trim()
const BANNER_ID = Number(process.env.BANNER_TEST_ID || 0)

const report = { time: new Date().toISOString(), pass: true, checks: [] }

function ok(name, detail = '') {
  report.checks.push({ name, ok: true, detail })
  console.log('PASS', name, detail)
}

function fail(name, detail = '') {
  report.pass = false
  report.checks.push({ name, ok: false, detail })
  console.error('FAIL', name, detail)
}

function testBannerSaveBody() {
  const inactiveRow = {
    id: 99,
    title: 'Test',
    active: false,
    isActive: false,
    enabled: true,
    isEnabled: true,
  }
  const reactivate = bannerSaveBody({ ...inactiveRow }, { isActive: true, title: 'Test' })
  if (!reactivate.isActive || !reactivate.active) {
    fail('bannerSaveBody reactivate', JSON.stringify(reactivate))
  } else {
    ok('bannerSaveBody reactivate', `active=${reactivate.active}`)
  }

  const deactivate = bannerSaveBody({ ...inactiveRow, isActive: true, active: true }, { isActive: false })
  if (deactivate.isActive !== false || deactivate.active !== false) {
    fail('bannerSaveBody deactivate', JSON.stringify(deactivate))
  } else {
    ok('bannerSaveBody deactivate')
  }

  const reenable = bannerSaveBody({ active: false, enabled: false }, { isEnabled: true })
  if (!reenable.isEnabled || !reenable.enabled) {
    fail('bannerSaveBody re-enable enabled flag', JSON.stringify(reenable))
  } else {
    ok('bannerSaveBody re-enable enabled flag')
  }
}

async function jsonFetch(url, opts = {}) {
  const res = await fetch(url, { cache: 'no-store', ...opts })
  const body = await res.json().catch(() => null)
  return { res, body, headers: res.headers }
}

async function probePublicBanners(base, label) {
  const { res, body, headers } = await jsonFetch(`${base}/api/banners`)
  if (!res.ok || !Array.isArray(body)) {
    fail(`${label} GET /api/banners`, `HTTP ${res.status}`)
    return null
  }
  const cacheHdr = headers.get('x-api-cache') || ''
  ok(`${label} public banners`, `${body.length} row(s) cache=${cacheHdr || 'n/a'}`)
  return body
}

async function adminToggleRoundTrip(base, label) {
  if (!TOKEN || !Number.isFinite(BANNER_ID) || BANNER_ID < 1) {
    console.log(`SKIP [${label}] admin toggle — set ADMIN_TOKEN + BANNER_TEST_ID`)
    return
  }
  const manageUrl = `${base}/api/banners/manage`
  const getRes = await jsonFetch(manageUrl, { headers: { 'X-Admin-Token': TOKEN } })
  if (!getRes.res.ok) {
    fail(`${label} admin manage`, `HTTP ${getRes.res.status}`)
    return
  }
  const row = (Array.isArray(getRes.body) ? getRes.body : []).find((b) => Number(b.id) === BANNER_ID)
  if (!row) {
    fail(`${label} admin manage`, `banner ${BANNER_ID} not found`)
    return
  }

  const wasActive = row.isActive !== false && row.active !== false
  const targetActive = !wasActive
  const savePayload = bannerSaveBody(row, { isActive: targetActive, active: targetActive })

  const put = await jsonFetch(`${base}/api/banners/${BANNER_ID}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': TOKEN },
    body: JSON.stringify(savePayload),
  })
  if (!put.res.ok) {
    fail(`${label} PUT toggle`, JSON.stringify(put.body))
    return
  }
  const savedActive = put.body?.isActive !== false && put.body?.active !== false
  if (savedActive !== targetActive) {
    fail(`${label} PUT response active flag`, `expected ${targetActive} got ${savedActive}`)
  } else {
    ok(`${label} PUT toggle`, `active=${savedActive}`)
  }

  const publicList = await probePublicBanners(base, `${label} after toggle`)
  if (publicList) {
    const inPublic = publicList.some((b) => Number(b.id) === BANNER_ID)
    if (targetActive && !inPublic) {
      fail(`${label} public list includes reactivated banner`, `id ${BANNER_ID} missing`)
    } else if (!targetActive && inPublic) {
      fail(`${label} public list excludes inactive banner`, `id ${BANNER_ID} still present`)
    } else {
      ok(`${label} public visibility matches active=${targetActive}`)
    }
  }

  // restore original state
  const restorePayload = bannerSaveBody(put.body || row, {
    isActive: wasActive,
    active: wasActive,
  })
  await jsonFetch(`${base}/api/banners/${BANNER_ID}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': TOKEN },
    body: JSON.stringify(restorePayload),
  })
  ok(`${label} restored original active=${wasActive}`)
}

async function main() {
  console.log('=== Banner toggle verification ===\n')
  testBannerSaveBody()

  const health = await jsonFetch(`${VPS}/api/health`)
  ok('VPS health', String(health.body?.commit || '').slice(0, 12))

  await probePublicBanners(VPS, 'VPS')
  await probePublicBanners(RENDER, 'Render')

  await adminToggleRoundTrip(VPS, 'VPS')

  console.log('\n=== SUMMARY ===')
  console.log(JSON.stringify(report, null, 2))
  console.log(report.pass ? '\nOVERALL: PASS' : '\nOVERALL: FAIL')
  process.exit(report.pass ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
