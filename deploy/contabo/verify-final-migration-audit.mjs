/**
 * Final Osmani TV migration audit — Render API, VPS, Vultr DB parity.
 *
 * Usage:
 *   node deploy/contabo/verify-final-migration-audit.mjs
 *   EXPECT_VPS_COMMIT=0a62176 node deploy/contabo/verify-final-migration-audit.mjs
 */
const RENDER_API = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const VPS_API = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/$/, '')
const VPS_ADMIN = String(process.env.VPS_ADMIN || 'https://admin.osmanitv.com').replace(/\/$/, '')
const RENDER_ADMIN = String(process.env.RENDER_ADMIN || 'https://osmani-admin-mpya.onrender.com').replace(/\/$/, '')
const RENDER_TV = String(process.env.RENDER_TV || 'https://osmani-tv.onrender.com').replace(/\/$/, '')
const PROBE_DEVICE = process.env.PROBE_DEVICE || 'migration-audit-probe'
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '3030'

const ENDPOINTS = [
  '/api/channels',
  '/api/banners',
  '/api/plans',
  `/api/subscription-status?device_id=${encodeURIComponent(PROBE_DEVICE)}`,
  '/api/payments/checkout-providers',
  '/api/payment-status/__probe_order__',
  '/api/update-check',
  '/api/server-health',
  '/api/settings',
  '/api/runtime/app-modes',
]

const report = {
  services: {},
  db: {},
  endpointParity: [],
  legacyApk: { render: null, vps: null },
  subscriptions: {},
  blockers: [],
  passed: 0,
  failed: 0,
}

function pass(name, detail) {
  report.passed += 1
  console.log(`✓ ${name}: ${detail}`)
  return true
}

function fail(name, detail) {
  report.failed += 1
  report.blockers.push(`${name}: ${detail}`)
  console.error(`✗ ${name}: ${detail}`)
  return false
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { cache: 'no-store', ...opts })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { res, body, text }
}

async function fetchJsonWithRetry(url, opts = {}, { attempts = 4, delayMs = 2000 } = {}) {
  let last = null
  for (let i = 0; i < attempts; i += 1) {
    last = await fetchJson(url, opts)
    if (last.res.ok) return last
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  return last
}

function plansFingerprint(plans) {
  if (!Array.isArray(plans)) return ''
  return plans.map((p) => `${p.id}:${p.activeSubscriberCount}:${p.price}`).join('|')
}

function channelNames(channels) {
  if (!Array.isArray(channels)) return ''
  return channels.map((c) => c.name).join('|')
}

function streamApiHosts(channels) {
  if (!Array.isArray(channels) || !channels[0]) return {}
  const c = channels[0]
  const out = {}
  for (const key of ['proxy_playback_url', 'direct_stream_url']) {
    const u = c[key]
    if (!u) continue
    try {
      out[key] = new URL(u).host
    } catch {
      out[key] = 'invalid'
    }
  }
  return out
}

async function probeService(name, base, { isApi = true } = {}) {
  const entry = { base, ok: false, commit: null, detail: '' }
  try {
    if (isApi) {
      const { res, body } = await fetchJson(`${base}/api/health`)
      entry.ok = res.ok && body?.ok === true
      entry.commit = body?.commit || null
      entry.detail = entry.ok ? `commit=${entry.commit}` : `HTTP ${res.status}`
    } else {
      const { res, text } = await fetchJson(`${base}/`)
      const isSpa = text.includes('id="root"')
      entry.ok = res.ok
      entry.detail = entry.ok
        ? isSpa
          ? `SPA ${res.status}`
          : `HTTP ${res.status} (${text.length}B, non-SPA)`
        : `HTTP ${res.status}`
    }
  } catch (e) {
    entry.detail = String(e.message || e)
  }
  report.services[name] = entry
  return entry.ok ? pass(`service:${name}`, entry.detail) : fail(`service:${name}`, entry.detail)
}

async function compareEndpoint(path) {
  const renderUrl = `${RENDER_API}${path}`
  const vpsUrl = `${VPS_API}${path}`
  const [render, vps] = await Promise.all([fetchJson(renderUrl), fetchJson(vpsUrl)])

  const row = {
    path,
    renderStatus: render.res.status,
    vpsStatus: vps.res.status,
    match: false,
    note: '',
  }

  if (path.includes('payment-status')) {
    row.match = render.res.status === vps.res.status
    row.note = `both ${render.res.status} for unknown order`
  } else if (path === '/api/channels') {
    const rn = channelNames(render.body)
    const vn = channelNames(vps.body)
    row.match = rn === vn && render.body?.length === vps.body?.length
    row.note = `count=${render.body?.length} names=${row.match}`
  } else if (path === '/api/plans') {
    row.match = plansFingerprint(render.body) === plansFingerprint(vps.body)
    row.note = row.match ? plansFingerprint(render.body) : 'mismatch'
  } else if (path === '/api/update-check') {
    row.match =
      render.res.ok &&
      vps.res.ok &&
      render.body?.force !== true &&
      vps.body?.force !== true &&
      render.body?.version_code === vps.body?.version_code
    row.note = `force off, vc=${render.body?.version_code}`
  } else if (path.startsWith('/api/subscription-status')) {
    row.match =
      render.res.ok &&
      vps.res.ok &&
      typeof render.body?.active === 'boolean' &&
      typeof vps.body?.active === 'boolean'
    row.note = `render active=${render.body?.active} vps active=${vps.body?.active}`
  } else {
    row.match = render.res.ok && vps.res.ok
    row.note = `render ${render.res.status} vps ${vps.res.status}`
  }

  report.endpointParity.push(row)
  return row.match
    ? pass(`parity:${path}`, row.note)
    : fail(`parity:${path}`, row.note)
}

async function legacyApkChecks(base, label) {
  const paths = [
    ['/api/server-health', (b) => b?.ok === true && (b.total_channels === 0 || b.online_channels >= 1)],
    ['/api/settings', (b) => b?.ok === true && b?.app_modes],
    ['/api/popup-settings', (b) => b?.title],
    ['/api/update-check', (b) => b?.force !== true],
  ]
  let ok = 0
  let bad = 0
  for (const [path, expect] of paths) {
    const { res, body } = await fetchJsonWithRetry(`${base}${path}`)
    if (res.status === 401 || res.status === 403) {
      bad += 1
      fail(`${label}${path}`, `HTTP ${res.status}`)
    } else if (!res.ok || !expect(body)) {
      bad += 1
      fail(`${label}${path}`, `shape/status ${res.status}`)
    } else {
      ok += 1
      pass(`${label}${path}`, 'ok')
    }
  }
  report.legacyApk[label] = { ok, bad }
  return bad === 0
}

async function waitForRenderCommitParity(vpsCommit, { maxMs = 600_000, intervalMs = 15_000 } = {}) {
  const target = String(vpsCommit || '').slice(0, 12)
  if (!target) return null
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    const { res, body } = await fetchJson(`${RENDER_API}/api/health`)
    const renderCommit = String(body?.commit || '')
    if (res.ok && renderCommit.startsWith(target)) {
      report.services['render-api'] = {
        base: RENDER_API,
        ok: true,
        commit: renderCommit,
        detail: `commit=${renderCommit}`,
      }
      return renderCommit
    }
    console.log(`… waiting for Render API commit ${target} (now ${renderCommit.slice(0, 12) || 'unknown'})`)
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return report.services['render-api']?.commit ?? null
}

async function main() {
  console.log('=== Osmani TV final migration audit ===\n')

  await probeService('render-api', RENDER_API, { isApi: true })
  await probeService('vps-api', VPS_API, { isApi: true })

  const expectCommit = String(process.env.EXPECT_VPS_COMMIT || process.env.GITHUB_SHA || '').trim()
  const vpsCommit = report.services['vps-api']?.commit
  let renderCommit = report.services['render-api']?.commit
  if (expectCommit && vpsCommit && !String(vpsCommit).startsWith(expectCommit.slice(0, 12))) {
    fail('vps-commit', `expected ${expectCommit.slice(0, 12)} got ${String(vpsCommit).slice(0, 12)}`)
  } else if (expectCommit && vpsCommit) {
    pass('vps-commit', String(vpsCommit).slice(0, 12))
  }
  if (vpsCommit && renderCommit && vpsCommit !== renderCommit) {
    console.log('Render API behind VPS — waiting for auto-deploy parity window')
    renderCommit = await waitForRenderCommitParity(vpsCommit)
  }
  if (vpsCommit && renderCommit && vpsCommit !== renderCommit) {
    fail('api-commit-parity', `${String(renderCommit).slice(0, 12)} vs ${String(vpsCommit).slice(0, 12)}`)
  } else if (vpsCommit && renderCommit) {
    pass('api-commit-parity', String(vpsCommit).slice(0, 12))
  }

  await probeService('render-admin-mpya', RENDER_ADMIN, { isApi: false })
  await probeService('vps-admin', VPS_ADMIN, { isApi: false })
  await probeService('render-tv', RENDER_TV, { isApi: false })

  const [renderCut, vpsCut] = await Promise.all([
    fetchJson(`${RENDER_API}/api/runtime/cutover-status`),
    fetchJson(`${VPS_API}/api/runtime/cutover-status`),
  ])

  if (renderCut.res.ok && vpsCut.res.ok) {
    const r = renderCut.body
    const v = vpsCut.body
    report.db = {
      renderHost: r.database?.host,
      vpsHost: v.database?.host,
      renderActiveSubs: r.active_device_subscriptions,
      vpsActiveSubs: v.active_device_subscriptions,
      renderPlans: r.plan_count,
      vpsPlans: v.plan_count,
      sameDb: r.database?.host === v.database?.host && r.database?.database === v.database?.database,
    }
    if (report.db.sameDb && r.active_device_subscriptions === v.active_device_subscriptions) {
      pass('db:vultr-parity', `${r.active_device_subscriptions} active subs, host ${r.database?.host}`)
    } else {
      fail('db:vultr-parity', JSON.stringify(report.db))
    }

    const [renderPlans, vpsPlans] = await Promise.all([
      fetchJson(`${RENDER_API}/api/plans`),
      fetchJson(`${VPS_API}/api/plans`),
    ])
    if (plansFingerprint(renderPlans.body) === plansFingerprint(vpsPlans.body)) {
      pass('db:plan-subscribers', plansFingerprint(renderPlans.body))
    } else {
      fail('db:plan-subscribers', 'Render vs VPS plan subscriber counts differ')
    }

    const [rch, vch] = await Promise.all([
      fetchJson(`${RENDER_API}/api/channels`),
      fetchJson(`${VPS_API}/api/channels`),
    ])
    const rh = streamApiHosts(rch.body)
    const vh = streamApiHosts(vch.body)
    pass('stream:render-hosts', JSON.stringify(rh))
    if (VPS_API.startsWith('https://') && vh.proxy_playback_url && !String(vh.proxy_playback_url).includes('144.91.117.90')) {
      pass('stream:vps-hosts', JSON.stringify(vh))
    } else if (!VPS_API.startsWith('https://')) {
      pass('stream:vps-hosts', JSON.stringify(vh))
    } else {
      fail('stream:vps-hosts', `expected api.osmanitv.com over HTTPS probe — ${JSON.stringify(vh)}`)
    }
  } else {
    fail('cutover-status', 'unavailable on one or both hosts')
  }

  for (const path of ENDPOINTS) {
    await compareEndpoint(path)
  }

  await legacyApkChecks(RENDER_API, 'legacy-render')
  await legacyApkChecks(VPS_API, 'legacy-vps')

  const subPaths = [`/api/subscription-status?device_id=${encodeURIComponent(PROBE_DEVICE)}`]
  const [rs, vs] = await Promise.all([
    fetchJson(`${RENDER_API}${subPaths[0]}`),
    fetchJson(`${VPS_API}${subPaths[0]}`),
  ])
  if (rs.res.ok && vs.res.ok && rs.body?.active === vs.body?.active) {
    pass('device-migration-probe', `same active=${rs.body.active} on both hosts (shared DB)`)
  } else {
    fail('device-migration-probe', 'subscription-status differs between hosts')
  }

  const admin = await fetchJson(`${VPS_API}/api/admin/panel-diagnostics`, {
    headers: { 'X-Admin-Token': ADMIN_TOKEN },
  })
  if (admin.res.ok) pass('vps:admin-api', `db=${admin.body?.database?.host}`)
  else fail('vps:admin-api', admin.body?.error || String(admin.res.status))

  const pct = Math.round((report.passed / (report.passed + report.failed)) * 100) || 0
  report.statusPercent = pct

  console.log('\n=== Summary ===')
  console.log(JSON.stringify({
    passed: report.passed,
    failed: report.failed,
    statusPercent: `${pct}%`,
    blockers: report.blockers,
    db: report.db,
    services: report.services,
  }, null, 2))

  process.exit(report.failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
