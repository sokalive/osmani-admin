/**
 * Render dashboard-equivalent proof for cost-reduction decisions.
 * Uses Render API (same workspace data as Dashboard → Services / Postgres / Metrics).
 *
 * Required:
 *   RENDER_API_KEY   https://dashboard.render.com/u/settings#api-keys
 *
 * Optional:
 *   RENDER_OWNER_ID
 *   RENDER_BILLING_SNAPSHOT_JSON   paste Billing accrued line items for exact $/mo
 *   AUDIT_DAYS                     default 7 (traffic window)
 *
 * Usage (PowerShell):
 *   $env:RENDER_API_KEY = "<key>"
 *   cd server
 *   node scripts/render-infrastructure-verify.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const KEY = String(process.env.RENDER_API_KEY || '').trim()
const AUDIT_DAYS = Number(process.env.AUDIT_DAYS) || 7
const TARGET_SERVICES = ['osmani-admin-api', 'osmani-tv']
const TARGET_DBS = ['osmani-db', 'tv-db']

const now = Date.now()
const endIso = new Date(now).toISOString()
const startIso = new Date(now - AUDIT_DAYS * 24 * 3600 * 1000).toISOString()
const start30Iso = new Date(now - 30 * 24 * 3600 * 1000).toISOString()

function loadBillingSnapshot() {
  const raw = process.env.RENDER_BILLING_SNAPSHOT_JSON || ''
  if (raw.trim()) {
    try {
      return JSON.parse(raw)
    } catch (e) {
      return { parseError: String(e.message) }
    }
  }
  const p = join(__dir, 'billing-snapshot.json')
  if (existsSync(p)) {
    try {
      return JSON.parse(readFileSync(p, 'utf8'))
    } catch (e) {
      return { parseError: String(e.message) }
    }
  }
  return null
}

async function renderFetch(path, params = {}) {
  const url = new URL(`https://api.render.com/v1${path}`)
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '') continue
    if (Array.isArray(v)) url.searchParams.append(k, v)
    else url.searchParams.set(k, String(v))
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' },
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text }
  }
  if (!res.ok) {
    throw new Error(`Render ${path} ${res.status}: ${JSON.stringify(json).slice(0, 400)}`)
  }
  return json
}

function unwrap(row) {
  return row?.service || row?.postgres || row?.envVar || row?.owner || row
}

function parseDbUrl(value) {
  const u = String(value || '').trim()
  if (!u) return { configured: false }
  try {
    const url = new URL(u)
    const dbName = String(url.pathname || '')
      .replace(/^\//, '')
      .split('/')[0]
      .split('?')[0]
    return {
      configured: true,
      host: url.hostname,
      port: url.port || '5432',
      database: dbName || null,
      user: url.username || null,
    }
  } catch {
    return { configured: true, parseError: true }
  }
}

function postgresHostFingerprints(pg) {
  const hosts = new Set()
  const add = (h) => {
    const s = String(h || '').trim().toLowerCase()
    if (s) hosts.add(s)
  }
  add(pg?.databaseUser)
  add(pg?.host)
  add(pg?.internalConnectionString)
  add(pg?.externalConnectionString)
  for (const key of ['internalDatabaseUrl', 'externalDatabaseUrl', 'connectionString']) {
    const fp = parseDbUrl(pg?.[key])
    if (fp.host) add(fp.host)
  }
  const details = pg?.serviceDetails || pg?.postgresDetails || pg
  add(details?.host)
  return [...hosts]
}

function matchPostgresByHost(pgList, host) {
  const h = String(host || '').trim().toLowerCase()
  if (!h) return null
  for (const row of pgList) {
    const pg = unwrap(row)
    const fps = postgresHostFingerprints(pg)
    if (fps.some((f) => h === f || h.includes(f) || f.includes(h))) return pg
    const name = String(pg?.name || '').toLowerCase()
    if (name && h.includes(name.replace(/_/g, '-'))) return pg
  }
  return null
}

function planMonthlyUsd(service) {
  const plan = String(
    service?.serviceDetails?.plan || service?.plan || service?.serviceDetails?.instanceType || '',
  ).toLowerCase()
  const type = String(service?.type || '').toLowerCase()
  if (type === 'static_site') return { plan, usd: 0, note: 'Static sites are $0 compute' }
  const diskGb = Number(service?.serviceDetails?.disk?.sizeGB || service?.disk?.sizeGB || 0)
  let usd = null
  if (plan.includes('pro plus')) usd = 175
  else if (plan.includes('pro max')) usd = 225
  else if (plan.includes('pro ultra')) usd = 450
  else if (plan.includes('pro')) usd = 85
  else if (plan.includes('standard')) usd = 25
  else if (plan.includes('starter')) usd = 7
  else if (plan.includes('free')) usd = 0
  const diskUsd = diskGb > 0 ? Number((diskGb * 0.25).toFixed(2)) : 0
  return {
    plan: plan || 'unknown',
    usd,
    disk_gb: diskGb || null,
    disk_usd_est: diskUsd || null,
    compute_usd_est: usd,
    total_usd_est: usd == null ? null : Number((usd + diskUsd).toFixed(2)),
    note: 'List price from plan name; paste RENDER_BILLING_SNAPSHOT_JSON for exact accrued $',
  }
}

function postgresMonthlyUsd(pg) {
  const plan = String(pg?.plan || pg?.serviceDetails?.plan || pg?.postgresDetails?.plan || '').toLowerCase()
  const ram = String(pg?.ram || pg?.serviceDetails?.ram || '').toLowerCase()
  let usd = null
  if (plan.includes('basic-1gb') || ram.includes('1gb')) usd = 19
  else if (plan.includes('basic-4gb')) usd = 75
  else if (plan.includes('basic-256') || plan.includes('basic_256') || ram.includes('256')) usd = 6
  else if (plan.includes('starter') || plan === 'starter') usd = 7
  else if (plan.includes('free')) usd = 0
  else if (plan.includes('pro')) usd = 55
  const diskGb = Number(pg?.diskSizeGB || pg?.serviceDetails?.diskSizeGB || 0)
  const storageUsd = diskGb > 1 ? Number(((diskGb - 1) * 0.3).toFixed(2)) : 0
  return {
    plan: plan || ram || 'unknown',
    compute_usd_est: usd,
    disk_gb: diskGb || null,
    storage_usd_est: storageUsd,
    total_usd_est: usd == null ? null : Number((usd + storageUsd).toFixed(2)),
    note: 'Estimate from plan/disk; Billing snapshot is authoritative',
  }
}

async function listAll(path, key = null) {
  const out = []
  let cursor = ''
  for (let i = 0; i < 20; i++) {
    const params = { limit: 100 }
    if (cursor) params.cursor = cursor
    const page = await renderFetch(path, params)
    const rows = Array.isArray(page) ? page : page?.data || page?.services || page?.postgres || []
    for (const row of rows) out.push(key ? row[key] ?? row : row)
    cursor = page?.cursor || page?.nextCursor || ''
    if (!cursor || rows.length === 0) break
  }
  return out
}

async function getServiceEnvVars(serviceId) {
  const rows = await listAll(`/services/${serviceId}/env-vars`)
  const map = {}
  for (const row of rows) {
    const ev = unwrap(row)
    if (ev?.key) map[ev.key] = ev.value ?? ev.val ?? ''
  }
  return map
}

async function metricsHttpRequests(resourceId, startTime, endTime) {
  try {
    const raw = await renderFetch('/metrics/http-requests-count', {
      resource: [resourceId],
      startTime,
      endTime,
    })
    let n = 0
    for (const row of raw?.data || []) {
      for (const v of row.values || []) n += Number(v.value ?? v) || 0
    }
    return n
  } catch {
    return null
  }
}

async function metricsBandwidthMb(resourceId, startTime, endTime) {
  try {
    const raw = await renderFetch('/metrics/bandwidth', {
      resource: [resourceId],
      startTime,
      endTime,
    })
    let mb = 0
    for (const row of raw?.data || []) {
      for (const v of row.values || []) mb += Number(v.value ?? v) || 0
    }
    return mb
  } catch {
    return null
  }
}

async function countRequestLogs(ownerId, resourceId, startTime, endTime) {
  let total = 0
  let cursorStart = startTime
  let cursorEnd = endTime
  for (let pages = 0; pages < 30; pages++) {
    const page = await renderFetch('/logs', {
      ownerId,
      resource: [resourceId],
      type: ['request'],
      startTime: cursorStart,
      endTime: cursorEnd,
      limit: 100,
      direction: 'backward',
    })
    const logs = page.logs || []
    total += logs.length
    if (!page.hasMore) break
    cursorEnd = page.nextEndTime
    cursorStart = page.nextStartTime
  }
  return total
}

function billingLineFor(snapshot, name) {
  if (!snapshot) return null
  const items = snapshot.items || snapshot.lines || snapshot.charges || snapshot
  if (!Array.isArray(items)) return snapshot[name] ?? null
  const hit = items.find((x) => JSON.stringify(x).toLowerCase().includes(String(name).toLowerCase()))
  return hit ?? null
}

async function main() {
  if (!KEY) {
    console.error(
      JSON.stringify(
        {
          error: 'RENDER_API_KEY is not set',
          hint: 'Create at https://dashboard.render.com/u/settings#api-keys then re-run',
        },
        null,
        2,
      ),
    )
    process.exit(1)
  }

  const owners = await renderFetch('/owners', { limit: 100 })
  const ownerList = (owners || []).map((o) => unwrap(o)).filter(Boolean)
  const ownerId =
    process.env.RENDER_OWNER_ID?.trim() || ownerList[0]?.id || ownerList[0]?.owner?.id

  const serviceRows = await listAll('/services')
  const services = serviceRows.map(unwrap)
  const postgresRows = await listAll('/postgres')
  const postgres = postgresRows.map(unwrap)

  const byName = (name) => services.find((s) => String(s.name) === name)
  const pgByName = (name) => postgres.find((p) => String(p.name) === name)

  const connections = {}
  for (const svcName of TARGET_SERVICES) {
    const svc = byName(svcName)
    if (!svc) {
      connections[svcName] = { error: 'service not found in workspace' }
      continue
    }
    const env = await getServiceEnvVars(svc.id)
    const dbUrl = env.DATABASE_URL || env.DATABASE_URL_PRIVATE || ''
    const fp = parseDbUrl(dbUrl)
    const matched = matchPostgresByHost(postgres, fp.host)
    connections[svcName] = {
      service_id: svc.id,
      suspended: svc.suspended,
      plan: planMonthlyUsd(svc),
      DATABASE_URL: {
        configured: fp.configured,
        host: fp.host || null,
        database: fp.database || null,
        user: fp.user || null,
      },
      matched_postgres_name: matched?.name || null,
      matched_postgres_id: matched?.id || null,
      verdict_osmani_db_vs_tv_db:
        matched?.name === 'osmani-db'
          ? 'osmani-db'
          : matched?.name === 'tv-db'
            ? 'tv-db'
            : matched?.name || 'UNMATCHED — compare host in Dashboard manually',
    }
  }

  const dbConnectedServices = {}
  for (const dbName of TARGET_DBS) {
    const pg = pgByName(dbName)
    if (!pg) {
      dbConnectedServices[dbName] = { error: 'postgres instance not found' }
      continue
    }
    const linked = []
    for (const svc of services) {
      if (!TARGET_SERVICES.includes(svc.name) && !String(svc.name || '').includes('osmani')) continue
      try {
        const env = await getServiceEnvVars(svc.id)
        const fp = parseDbUrl(env.DATABASE_URL || env.DATABASE_URL_PRIVATE || '')
        const matched = matchPostgresByHost([pg], fp.host)
        if (matched || fp.host?.includes(String(pg.name).replace(/-/g, ''))) {
          linked.push({ name: svc.name, id: svc.id, host: fp.host, database: fp.database })
        }
      } catch {
        /* skip */
      }
    }
    dbConnectedServices[dbName] = {
      postgres_id: pg.id,
      region: pg.region || null,
      plan: postgresMonthlyUsd(pg),
      status: pg.status || pg.suspended,
      linked_services: linked,
      dashboard_note:
        'Render Dashboard → Postgres → Info may list linked services; API infers from each service DATABASE_URL host',
    }
  }

  const traffic = {}
  const tv = byName('osmani-tv')
  const api = byName('osmani-admin-api')
  if (tv) {
    const req7 = await metricsHttpRequests(tv.id, startIso, endIso)
    const req30 = await metricsHttpRequests(tv.id, start30Iso, endIso)
    const bw7mb = await metricsBandwidthMb(tv.id, startIso, endIso)
    let logs7 = null
    if (ownerId) {
      try {
        logs7 = await countRequestLogs(ownerId, tv.id, startIso, endIso)
      } catch (e) {
        logs7 = { error: String(e.message) }
      }
    }
    const apiReq7 = api ? await metricsHttpRequests(api.id, startIso, endIso) : null
    traffic.osmani_tv = {
      window_days: AUDIT_DAYS,
      http_requests_count_metrics: req7,
      http_requests_count_30d_metrics: req30,
      request_logs_sampled_count: logs7,
      bandwidth_mb: bw7mb,
      bandwidth_gb: bw7mb == null ? null : Number((bw7mb / 1000).toFixed(4)),
      osmani_admin_api_requests_7d_for_ratio: apiReq7,
      production_traffic_verdict:
        req7 === 0 && (logs7 === 0 || logs7 === null)
          ? 'NO measurable traffic in window — effectively unused'
          : req7 != null && apiReq7 != null && req7 < apiReq7 * 0.01
            ? 'NEGLIGIBLE vs osmani-admin-api (<1% requests)'
            : req7 != null && req7 > 0
              ? 'ACTIVE — do not delete without investigating top paths in Dashboard logs'
              : 'INCONCLUSIVE — check Dashboard → osmani-tv → Metrics/Logs',
    }
  }

  const snapshot = loadBillingSnapshot()
  const costs = {
    osmani_tv: {
      service: byName('osmani-tv') ? planMonthlyUsd(byName('osmani-tv')) : null,
      billing_snapshot_line: billingLineFor(snapshot, 'osmani-tv'),
    },
    tv_db: {
      postgres: pgByName('tv-db') ? postgresMonthlyUsd(pgByName('tv-db')) : null,
      billing_snapshot_line: billingLineFor(snapshot, 'tv-db'),
    },
    note: 'Exact monthly cost = Dashboard → Billing accrued charges. Estimates use public list prices only.',
  }

  const adminApiDb = connections['osmani-admin-api']?.verdict_osmani_db_vs_tv_db
  const tvSvcDb = connections['osmani-tv']?.verdict_osmani_db_vs_tv_db
  const tvTraffic = traffic.osmani_tv?.production_traffic_verdict || 'unknown'

  let safe_suspend_osmani_tv = 'UNVERIFIED — run this script with RENDER_API_KEY'
  let safe_delete_tv_db = 'UNVERIFIED — run this script with RENDER_API_KEY'

  if (adminApiDb && adminApiDb !== 'tv-db') {
    if (tvSvcDb === 'tv-db' || tvSvcDb === 'UNMATCHED') {
      if (tvTraffic.startsWith('NO') || tvTraffic.startsWith('NEGLIGIBLE')) {
        safe_suspend_osmani_tv =
          'LIKELY YES after manual Billing check — suspend first, monitor 72h; production uses osmani-admin-api + osmani-db'
      } else if (tvTraffic.startsWith('ACTIVE')) {
        safe_suspend_osmani_tv = 'NO until traffic source identified (Dashboard logs)'
      }
    }
    if (
      dbConnectedServices['tv-db']?.linked_services?.length === 1 &&
      dbConnectedServices['tv-db'].linked_services[0]?.name === 'osmani-tv' &&
      adminApiDb === 'osmani-db' &&
      (tvTraffic.startsWith('NO') || tvTraffic.startsWith('NEGLIGIBLE'))
    ) {
      safe_delete_tv_db =
        'LIKELY YES after pg_dump backup — only osmani-tv linked; admin-api not on tv-db'
    } else if (dbConnectedServices['tv-db']?.linked_services?.some((s) => s.name === 'osmani-admin-api')) {
      safe_delete_tv_db = 'NO — osmani-admin-api is linked to tv-db'
    }
  }

  const report = {
    generated_at: new Date().toISOString(),
    owner_id: ownerId,
    audit_window: { start: startIso, end: endIso, days: AUDIT_DAYS },
    answers: {
      '1_osmani_admin_api_database': connections['osmani-admin-api'] ?? null,
      '2_osmani_tv_database': connections['osmani-tv'] ?? null,
      '3_connected_services_per_database': dbConnectedServices,
      '4_osmani_tv_traffic': traffic.osmani_tv ?? null,
      '5_monthly_costs': costs,
    },
    safety_verdict: {
      suspend_osmani_tv: safe_suspend_osmani_tv,
      delete_tv_db: safe_delete_tv_db,
      disclaimer:
        'Final safety requires matching this output to Dashboard → Billing + 72h post-suspend monitoring of APK/admin/payments.',
    },
  }

  console.log(JSON.stringify(report, null, 2))
}

main().catch((e) => {
  console.error(JSON.stringify({ error: String(e.message || e) }, null, 2))
  process.exit(1)
})
