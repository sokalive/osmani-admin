/**
 * VPS migration audit — live proof from shared Postgres + dual-host probes.
 *
 * Usage:
 *   ADMIN_TOKEN=3030 node scripts/audit-vps-migration-by-version.mjs
 *   VPS_API=https://api.osmanitv.com RENDER_API=https://osmani-admin-api.onrender.com node scripts/audit-vps-migration-by-version.mjs
 *
 * With DATABASE_URL set, also runs DB audit locally (same queries as /api/runtime/vps-migration-audit).
 */
import pg from 'pg'

const VPS_API = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const RENDER_API = String(
  process.env.RENDER_API || 'https://osmani-admin-api.onrender.com',
).replace(/\/+$/, '')
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '3030').trim()
const WINDOW_DAYS = Number(process.env.AUDIT_WINDOW_DAYS || 7)

const VERSIONS = [15, 16, 17, 18, 19, 20, 21, 22, 23, 24]
const ENDPOINTS = [
  '/api/channels',
  '/api/subscription/verify',
  '/api/update-check',
  '/api/payments/checkout-providers',
  '/api/settings',
]

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { cache: 'no-store', ...opts })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { _raw: text.slice(0, 300) }
  }
  return { status: res.status, body }
}

async function probeHostEndpoints(label, base) {
  const row = { label, base, endpoints: {}, updateMatrix: {} }
  for (const ep of ENDPOINTS) {
    try {
      const { status, body } = await fetchJson(`${base}${ep}`)
      row.endpoints[ep] = { status, ok: status >= 200 && status < 400 }
    } catch (e) {
      row.endpoints[ep] = { error: e.message }
    }
  }
  for (const v of VERSIONS) {
    try {
      const { status, body } = await fetchJson(`${base}/api/update-check?version_code=${v}`)
      row.updateMatrix[`v${v}`] = body?.decision ?? `HTTP_${status}`
    } catch (e) {
      row.updateMatrix[`v${v}`] = 'ERR'
    }
  }
  return row
}

async function fetchDbAuditViaApi(base) {
  const { status, body } = await fetchJson(
    `${base}/api/runtime/vps-migration-audit?window_days=${WINDOW_DAYS}`,
    { headers: { 'X-Admin-Token': ADMIN_TOKEN, Accept: 'application/json' } },
  )
  return { base, status, body }
}

async function fetchDbAuditLocal() {
  const url = String(process.env.DATABASE_URL || '').trim()
  if (!url) return null
  process.env.DATABASE_URL = url
  const { runVpsMigrationAudit } = await import('../src/lib/vpsMigrationAudit.js')
  return runVpsMigrationAudit({ windowDays: WINDOW_DAYS })
}

function printMatrixTable(matrix) {
  console.log('\nVersion | VPS | Render | OTA Eligible | Migration Complete')
  for (const row of matrix || []) {
    console.log(
      `${row.version} | ${row.vps} | ${row.render} | ${row.ota_eligible} | ${row.migration_complete}`,
    )
  }
}

function mergeMatrixFromDb(dbReport) {
  return (dbReport?.matrix || []).map((r) => ({
    version: r.version,
    vps: r.vps,
    render: r.render,
    ota_eligible: r.ota_eligible,
    migration_complete: r.migration_complete,
    vps_requests: r.vps_requests,
    render_requests: r.render_requests,
    registry_devices: r.registry_devices,
  }))
}

async function main() {
  console.log('=== VPS MIGRATION AUDIT ===')
  console.log('window_days:', WINDOW_DAYS)
  console.log('VPS:', VPS_API)
  console.log('Render:', RENDER_API)

  const vpsProbe = await probeHostEndpoints('VPS', VPS_API)
  const renderProbe = await probeHostEndpoints('Render', RENDER_API)
  console.log('\n--- Host endpoint probes ---')
  console.log(JSON.stringify({ vps: vpsProbe, render: renderProbe }, null, 2))

  const [vpsCutover, renderCutover] = await Promise.all([
    fetchJson(`${VPS_API}/api/runtime/cutover-status`),
    fetchJson(`${RENDER_API}/api/runtime/cutover-status`),
  ])
  console.log('\n--- Shared DB proof ---')
  console.log(
    JSON.stringify(
      {
        vps_db: vpsCutover.body?.database,
        render_db: renderCutover.body?.database,
        same_db:
          vpsCutover.body?.database?.host === renderCutover.body?.database?.host &&
          vpsCutover.body?.database?.database === renderCutover.body?.database?.database,
        vps_base_url: vpsCutover.body?.base_url,
        render_base_url: renderCutover.body?.base_url,
        vps_commit: vpsCutover.body?.commit?.slice?.(0, 7),
        render_commit: renderCutover.body?.commit?.slice?.(0, 7),
      },
      null,
      2,
    ),
  )

  let dbReport = await fetchDbAuditLocal()
  if (!dbReport?.ok) {
    const remote = await fetchDbAuditViaApi(VPS_API)
    if (remote.status === 404) {
      console.warn('\nRemote audit endpoint not deployed yet — deploy latest commit first.')
    } else if (remote.status !== 200) {
      console.warn('\nRemote audit failed:', remote.status, remote.body)
    } else {
      dbReport = remote.body
    }
  }

  if (dbReport?.ok) {
    console.log('\n--- DB telemetry matrix ---')
    printMatrixTable(dbReport.matrix)
    console.log('\n--- Conclusions ---')
    console.log(JSON.stringify(dbReport.conclusions, null, 2))
    console.log('\nRegistry app_version counts (7d):')
    console.log(JSON.stringify(dbReport.registry_app_versions, null, 2))
  } else {
    console.warn('\nNo DB audit available (set DATABASE_URL or deploy /api/runtime/vps-migration-audit)')
  }

  console.log('\n--- Update-check matrix (live API proof) ---')
  console.log(['Host', ...VERSIONS.map((v) => `v${v}`)].join('\t'))
  for (const probe of [vpsProbe, renderProbe]) {
    console.log([probe.label, ...VERSIONS.map((v) => probe.updateMatrix[`v${v}`] ?? '?')].join('\t'))
  }

  const matrix = dbReport?.ok ? mergeMatrixFromDb(dbReport) : null
  const conclusions = dbReport?.conclusions || {}
  const canShut =
    conclusions.can_shut_render_today ||
    (renderProbe.endpoints['/api/channels']?.status >= 500 ? 'POSSIBLE if Render down and users OK' : 'Run after telemetry window')

  console.log('\n=== FINAL ===')
  console.log('Can Render be permanently shut down today?', canShut)
  console.log('Versions still depend on Render:', conclusions.versions_still_on_render_only || [])
  console.log('Versions fully migrated to VPS:', conclusions.versions_fully_migrated || conclusions.versions_vps_only || [])

  if (matrix) {
    const bad = matrix.filter((r) => r.render === 'Yes' && r.vps !== 'Yes')
    if (bad.length > 0) process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
