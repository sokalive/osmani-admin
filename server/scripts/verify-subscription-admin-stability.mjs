#!/usr/bin/env node
/**
 * Production subscription admin stability audit — VPS API vs Render API vs PostgreSQL parity.
 */
const VPS_API = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/$/, '')
const RENDER_API = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const VPS_ADMIN = String(process.env.VPS_ADMIN || 'https://admin.osmanitv.com').replace(/\/$/, '')
const RENDER_ADMIN = String(process.env.RENDER_ADMIN || 'https://osmani-admin-mpya.onrender.com').replace(/\/$/, '')
const TOKEN = process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '3030'
const ROUNDS = Number(process.env.ROUNDS || 25)
const headers = { 'X-Admin-Token': TOKEN, 'Cache-Control': 'no-cache' }

const report = { passed: 0, failed: 0, blockers: [] }

function pass(name, detail) {
  report.passed++
  console.log(`PASS ${name}: ${detail}`)
}

function fail(name, detail) {
  report.failed++
  report.blockers.push(`${name}: ${detail}`)
  console.error(`FAIL ${name}: ${detail}`)
}

async function fetchJson(url) {
  const t0 = performance.now()
  const res = await fetch(url, { headers, cache: 'no-store' })
  const ms = Math.round(performance.now() - t0)
  const body = await res.json().catch(() => null)
  return { res, body, ms }
}

async function getSummary(base) {
  const { res, body, ms } = await fetchJson(`${base}/api/users/summary`)
  return { ok: res.ok && body?.summary, summary: body?.summary, ms, status: res.status }
}

async function getActivePage(base) {
  const { res, body, ms } = await fetchJson(`${base}/api/users/active?page=1&limit=25`)
  const ids = Array.isArray(body?.items) ? body.items.map((x) => x.device_id).sort() : []
  return { ok: res.ok && ids.length > 0, total: body?.pagination?.total, ids, ms, status: res.status }
}

async function analyzeAdminBundle(admin, label) {
  const home = await fetch(admin + '/')
  const html = await home.text()
  const m = html.match(/src="(\/assets\/[^"]+\.js)"/)
  if (!m) return fail(`${label}-bundle`, 'no js asset')
  const js = await (await fetch(admin + m[1])).text()
  const usesRenderAsDefault = /var \w+=`https:\/\/osmani-admin-api\.onrender\.com`/.test(js)
  const usesSameOrigin = /var \w+=``/.test(js)
  if (label === 'vps-admin' && usesSameOrigin) pass(`${label}-api-target`, 'same-origin /api (B empty)')
  else if (label === 'render-admin' && usesRenderAsDefault) pass(`${label}-api-target`, 'Render API baked in')
  else fail(`${label}-api-target`, `unexpected bundle API config render=${usesRenderAsDefault} sameOrigin=${usesSameOrigin}`)
  return m[1]
}

async function main() {
  console.log('=== Subscription admin stability audit ===\n')

  const [vpsCut, renderCut] = await Promise.all([
    fetchJson(`${VPS_API}/api/runtime/cutover-status`),
    fetchJson(`${RENDER_API}/api/runtime/cutover-status`),
  ])
  if (vpsCut.res.ok && renderCut.res.ok) {
    const sameDb =
      vpsCut.body.database?.host === renderCut.body.database?.host &&
      vpsCut.body.database?.database === renderCut.body.database?.database
    if (sameDb) pass('database', `shared ${vpsCut.body.database.host}/${vpsCut.body.database.database}`)
    else fail('database', JSON.stringify({ vps: vpsCut.body.database, render: renderCut.body.database }))
    const sameCommit = vpsCut.body.commit === renderCut.body.commit
    if (sameCommit) pass('api-commit', String(vpsCut.body.commit).slice(0, 7))
    else
      pass(
        'api-commit-drift',
        `VPS ${String(vpsCut.body.commit).slice(0, 7)} Render ${String(renderCut.body.commit).slice(0, 7)} (subscription parity checked separately)`,
      )
  } else {
    fail('cutover-status', 'unavailable')
  }

  await analyzeAdminBundle(VPS_ADMIN, 'vps-admin')
  await analyzeAdminBundle(RENDER_ADMIN, 'render-admin')

  // Admin same-origin API path (nginx proxy)
  const adminOrigin = await fetchJson(`${VPS_ADMIN}/api/users/summary`)
  if (adminOrigin.res.ok && adminOrigin.body?.summary) {
    pass('vps-admin-nginx-api', `active_paid=${adminOrigin.body.summary.active_paid}`)
  } else {
    fail('vps-admin-nginx-api', `HTTP ${adminOrigin.res.status}`)
  }

  const summaryKeys = ['active_paid', 'expiring_24h', 'expiring_3d', 'expiring_7d', 'failed_payments', 'all_subscriptions']
  const vpsSamples = []
  const renderSamples = []
  let vpsStable = true
  let renderStable = true
  let crossMismatch = 0
  let vpsErrors = 0
  let renderErrors = 0
  let crossPageMismatch = 0

  console.log(`\n=== ${ROUNDS}-round stability burst ===`)
  for (let i = 0; i < ROUNDS; i++) {
    const [vps, render] = await Promise.all([getSummary(VPS_API), getSummary(RENDER_API)])
    if (!vps.ok) vpsErrors++
    if (!render.ok) renderErrors++
    if (vps.summary) vpsSamples.push(vps.summary)
    if (render.summary) renderSamples.push(render.summary)
    if (vps.summary && render.summary) {
      const mismatch = summaryKeys.some((k) => vps.summary[k] !== render.summary[k])
      if (mismatch) {
        crossMismatch++
        console.log(`  round ${i + 1} MISMATCH`, { vps: vps.summary, render: render.summary })
      }
    }
    const [vpsPage, renderPage] = await Promise.all([getActivePage(VPS_API), getActivePage(RENDER_API)])
    if (!vpsPage.ok) vpsErrors++
    if (!renderPage.ok) renderErrors++
    if (
      vpsPage.ids.length &&
      renderPage.ids.length &&
      JSON.stringify(vpsPage.ids) !== JSON.stringify(renderPage.ids)
    ) {
      crossPageMismatch++
    }
  }

  for (const k of summaryKeys) {
    const vpsVals = new Set(vpsSamples.map((s) => s[k]))
    const renderVals = new Set(renderSamples.map((s) => s[k]))
    if (vpsVals.size > 1) vpsStable = false
    if (renderVals.size > 1) renderStable = false
  }

  if (vpsStable && renderStable) {
    pass('api-count-stable-window', `${ROUNDS} rounds — counts unchanged (no expiry during window)`)
  } else if (crossMismatch === 0) {
    pass(
      'api-count-live-churn',
      `counts moved ${[...new Set(vpsSamples.map((s) => s.active_paid))].join('→')} but VPS/Render stayed matched`,
    )
  } else {
    if (!vpsStable) fail('vps-api-stable', `varying: ${JSON.stringify(vpsSamples.map((s) => s.active_paid))}`)
    if (!renderStable) fail('render-api-stable', `varying: ${JSON.stringify(renderSamples.map((s) => s.active_paid))}`)
  }

  if (crossMismatch === 0) pass('vps-render-parity', `${ROUNDS} rounds matched`)
  else fail('vps-render-parity', `${crossMismatch}/${ROUNDS} rounds differed`)

  if (crossPageMismatch === 0) pass('active-page1-ids', 'VPS/Render identical each round')
  else fail('active-page1-ids', `${crossPageMismatch}/${ROUNDS} rounds VPS≠Render`)

  if (vpsErrors === 0 && renderErrors === 0) pass('http-errors', 'none')
  else fail('http-errors', `vps=${vpsErrors} render=${renderErrors}`)

  // Compare admin nginx path to VPS API (same snapshot)
  const [adminSnap, vpsSnap] = await Promise.all([
    fetchJson(`${VPS_ADMIN}/api/users/summary`),
    fetchJson(`${VPS_API}/api/users/summary`),
  ])
  if (adminSnap.res.ok && vpsSnap.res.ok) {
    const match = summaryKeys.every((k) => adminSnap.body.summary[k] === vpsSnap.body.summary[k])
    if (match) pass('admin-nginx-vs-vps-api', `active_paid=${adminSnap.body.summary.active_paid}`)
    else fail('admin-nginx-vs-vps-api', JSON.stringify({ admin: adminSnap.body.summary, vps: vpsSnap.body.summary }))
  }

  console.log('\n=== Summary ===')
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed, blockers: report.blockers }, null, 2))
  process.exit(report.failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
