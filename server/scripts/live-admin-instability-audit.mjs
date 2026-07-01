#!/usr/bin/env node
/**
 * Live production admin instability audit — VPS vs Render, no assumptions.
 * Usage: node server/scripts/live-admin-instability-audit.mjs
 */
const VPS_API = 'https://api.osmanitv.com'
const RENDER_API = 'https://osmani-admin-api.onrender.com'
const VPS_ADMIN = 'https://admin.osmanitv.com'
const RENDER_ADMIN = 'https://osmani-admin-mpya.onrender.com'
const TOKEN = process.env.ADMIN_TOKEN || '3030'
const ROUNDS = Number(process.env.ROUNDS || 100)
const headers = { 'X-Admin-Token': TOKEN, 'Cache-Control': 'no-cache' }

const report = { ts: new Date().toISOString(), checks: [] }

function record(name, ok, detail, extra = {}) {
  report.checks.push({ name, ok, detail, ...extra })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`)
}

async function fetchJson(url, opts = {}) {
  const t0 = performance.now()
  const res = await fetch(url, { headers, cache: 'no-store', ...opts })
  const ms = Math.round(performance.now() - t0)
  const body = await res.json().catch(() => null)
  return { res, body, ms }
}

async function bundleInfo(admin) {
  const home = await fetch(admin + '/')
  const html = await home.text()
  const m = html.match(/src="(\/assets\/[^"]+\.js)"/)
  if (!m) return { error: 'no bundle' }
  const js = await (await fetch(admin + m[1])).text()
  return {
    bundle: m[1],
    sameOriginApi: /var \w+=``/.test(js),
    renderDefaultApi: /var \w+=`https:\/\/osmani-admin-api\.onrender\.com`/.test(js),
    // UsersPage stability markers (minified)
    keepsRowsOnError: !js.includes('setItems([])') || js.includes('Keep prior rows') === false,
    sseDebounce1500: js.includes(',1500)'),
    userProfileDrawer: js.includes('Wasifu wa mtumiaji') || js.includes('Muhtasari'),
    noUpdatingLabel: !js.includes('Updating\u2026') && !js.includes('Updating…'),
  }
}

async function main() {
  console.log('=== LIVE ADMIN INSTABILITY AUDIT ===')
  console.log('Time:', report.ts)
  console.log('Rounds:', ROUNDS, '\n')

  const [vpsCut, renderCut, vpsAdminApi, renderAdminApi] = await Promise.all([
    fetchJson(`${VPS_API}/api/runtime/cutover-status`),
    fetchJson(`${RENDER_API}/api/runtime/cutover-status`),
    fetchJson(`${VPS_ADMIN}/api/runtime/cutover-status`),
    fetchJson(`${RENDER_ADMIN}/api/runtime/cutover-status`).catch(() => ({
      res: { ok: false, status: 0 },
      body: null,
    })),
  ])

  const vdb = vpsCut.body?.database
  const rdb = renderCut.body?.database
  const sameDb =
    vdb?.host === rdb?.host && vdb?.database === rdb?.database && vdb?.port === rdb?.port
  record(
    'postgresql-same-host',
    sameDb,
    sameDb ? `${vdb.host}:${vdb.port}/${vdb.database}` : `vps=${JSON.stringify(vdb)} render=${JSON.stringify(rdb)}`,
    { vpsActiveSubs: vpsCut.body?.active_device_subscriptions, renderActiveSubs: renderCut.body?.active_device_subscriptions },
  )

  record(
    'api-commits',
    vpsCut.body?.commit === renderCut.body?.commit,
    `VPS=${String(vpsCut.body?.commit || '').slice(0, 7)} Render=${String(renderCut.body?.commit || '').slice(0, 7)}`,
  )
  if (vpsCut.body?.commit !== renderCut.body?.commit) {
    console.error('\nBLOCKED: VPS and Render API are on different commits. Deploy Render to match before parity audit.')
    process.exit(1)
  }

  const [vpsB, renderB] = await Promise.all([bundleInfo(VPS_ADMIN), bundleInfo(RENDER_ADMIN)])
  record(
    'vps-admin-api-routing',
    vpsB.sameOriginApi && !vpsB.renderDefaultApi,
    JSON.stringify(vpsB),
  )
  record(
    'render-admin-api-routing',
    renderB.renderDefaultApi,
    JSON.stringify(renderB),
  )

  if (vpsAdminApi.res.ok) {
    record(
      'vps-admin-nginx-api-db',
      vpsAdminApi.body?.database?.host === vdb?.host,
      `admin nginx api db=${vpsAdminApi.body?.database?.host}`,
    )
  }

  const summaryKeys = [
    'active_paid',
    'expiring_24h',
    'expiring_3d',
    'expiring_7d',
    'failed_payments',
    'all_subscriptions',
  ]

  let parityFail = 0
  let httpFail = 0
  const vpsActivePaid = new Set()
  const renderActivePaid = new Set()
  let searchParityFail = 0
  let pageIdParityFail = 0
  let summaryListMismatch = 0

  console.log(`\n=== ${ROUNDS}-round refresh simulation ===`)
  for (let i = 0; i < ROUNDS; i++) {
    const [vs, rs] = await Promise.all([
      fetchJson(`${VPS_API}/api/users/summary`),
      fetchJson(`${RENDER_API}/api/users/summary`),
    ])
    if (!vs.res.ok || !rs.res.ok) httpFail++

    const vSum = vs.body?.summary
    const rSum = rs.body?.summary
    if (vSum && rSum) {
      vpsActivePaid.add(vSum.active_paid)
      renderActivePaid.add(rSum.active_paid)
      const mismatch = summaryKeys.some((k) => vSum[k] !== rSum[k])
      if (mismatch) {
        parityFail++
        if (parityFail <= 3) console.log(`  parity mismatch round ${i + 1}`, { vSum, rSum })
      }
    }

    const [va, ra, vSearch, rSearch] = await Promise.all([
      fetchJson(`${VPS_API}/api/users/active?page=1&limit=25`),
      fetchJson(`${RENDER_API}/api/users/active?page=1&limit=25`),
      fetchJson(`${VPS_API}/api/users/active?search=255&page=1&limit=25`),
      fetchJson(`${RENDER_API}/api/users/active?search=255&page=1&limit=25`),
    ])

    const vIds = (va.body?.items || []).map((x) => x.device_id).sort().join(',')
    const rIds = (ra.body?.items || []).map((x) => x.device_id).sort().join(',')
    if (vIds && rIds && vIds !== rIds) pageIdParityFail++

    if (vSearch.body?.pagination?.total !== rSearch.body?.pagination?.total) searchParityFail++

    if (vSum?.active_paid !== va.body?.pagination?.total) summaryListMismatch++
  }

  record('http-errors', httpFail === 0, `failures=${httpFail}/${ROUNDS}`)
  record('vps-render-summary-parity', parityFail === 0, `${ROUNDS - parityFail}/${ROUNDS} matched`)
  record(
    'active-paid-live-range',
    true,
    `VPS values=[${[...vpsActivePaid].join(',')}] Render=[${[...renderActivePaid].join(',')}] (expiry churn if >1 value)`,
  )
  record('search-parity', searchParityFail === 0, `${ROUNDS - searchParityFail}/${ROUNDS} matched`)
  record('page1-ids-parity', pageIdParityFail === 0, `${ROUNDS - pageIdParityFail}/${ROUNDS} matched`)
  record(
    'summary-vs-list-total-vps',
    summaryListMismatch === 0,
    `${ROUNDS - summaryListMismatch}/${ROUNDS} summary.active_paid === list.total`,
  )

  // Tab endpoints snapshot
  const endpoints = [
    ['active', '/api/users/active?page=1&limit=25'],
    ['expiring-7d', '/api/users/expiring?within=7d&page=1&limit=25'],
    ['failed', '/api/users/failed-payments?page=1&limit=25'],
    ['all', '/api/users?page=1&limit=25'],
  ]
  console.log('\n=== Tab endpoint parity ===')
  for (const [name, path] of endpoints) {
    const [v, r] = await Promise.all([
      fetchJson(`${VPS_API}${path}`),
      fetchJson(`${RENDER_API}${path}`),
    ])
    const vt = v.body?.pagination?.total
    const rt = r.body?.pagination?.total
    record(`tab-${name}`, vt === rt, `vps total=${vt} render total=${rt}`)
  }

  // Cache headers
  const cacheProbe = await fetch(`${VPS_API}/api/users/summary`, { headers, cache: 'no-store' })
  record(
    'cache-control-no-store',
    String(cacheProbe.headers.get('cache-control') || '').includes('no-store'),
    cacheProbe.headers.get('cache-control') || '(missing)',
  )

  const failed = report.checks.filter((c) => !c.ok)
  report.summary = { total: report.checks.length, failed: failed.length, failedNames: failed.map((f) => f.name) }
  console.log('\n=== JSON REPORT ===')
  console.log(JSON.stringify(report, null, 2))
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
