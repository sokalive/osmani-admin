/**
 * Billing-grade audit using Render Metrics + Logs APIs and Bunny Statistics.
 *
 * Render does NOT expose a public Billing/Invoice API — paste dashboard accruals via
 * RENDER_BILLING_SNAPSHOT_JSON for line-item reconciliation.
 *
 * Required:
 *   RENDER_API_KEY
 *
 * Optional:
 *   RENDER_OWNER_ID          workspace id (tea-…); auto-discovered if omitted
 *   RENDER_SERVICE_ID        force osmani-admin-api id
 *   BUNNY_API_KEY
 *   BUNNY_PULL_ZONE_ID
 *   API_BASE                 production API for stream metrics
 *   AUDIT_HOURS              default 24
 *   RENDER_BANDWIDTH_USD_PER_GB  default 0.15
 *   RENDER_INCLUDED_BANDWIDTH_GB   workspace included GB (Hobby 5, Pro 25, etc.)
 *   RENDER_BILLING_SNAPSHOT_JSON   paste from Dashboard → Billing accrued charges
 *
 * Usage: node scripts/billing-grade-audit.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const API = (process.env.API_BASE || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const RENDER_KEY = String(process.env.RENDER_API_KEY || '').trim()
const BUNNY_KEY = String(process.env.BUNNY_API_KEY || process.env.BUNNY_ACCOUNT_API_KEY || '').trim()
const HOURS = Number(process.env.AUDIT_HOURS) || 24
const BW_USD_PER_GB = Number(process.env.RENDER_BANDWIDTH_USD_PER_GB) || 0.15
const INCLUDED_GB = Number(process.env.RENDER_INCLUDED_BANDWIDTH_GB) || 0

const now = Date.now()
const start24h = new Date(now - HOURS * 3600 * 1000).toISOString()
const endNow = new Date(now).toISOString()
const monthStart = new Date()
monthStart.setUTCDate(1)
monthStart.setUTCHours(0, 0, 0, 0)
const startMtd = monthStart.toISOString()

function gbFromMb(mb) {
  return Number(mb || 0) / 1000
}

function sumMetricSeries(body) {
  let mb = 0
  const rows = body?.data || body?.metrics || (Array.isArray(body) ? body : [])
  for (const row of rows) {
    for (const v of row.values || []) {
      mb += Number(v.value ?? v) || 0
    }
  }
  return mb
}

function sumBandwidthSources(body) {
  const out = { total: 0, http: 0, websocket: 0, nat: 0, privatelink: 0 }
  for (const row of body?.data || []) {
    const src = String(row.labels?.trafficSource || 'total').toLowerCase()
    const mb = (row.values || []).reduce((s, v) => s + (Number(v.value) || 0), 0)
    if (src in out) out[src] += mb
    if (src === 'total') out.total += mb
  }
  if (!out.total) out.total = out.http + out.websocket + out.nat + out.privatelink
  return out
}

async function renderFetch(path, params = {}) {
  const url = new URL(`https://api.render.com/v1${path}`)
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '') continue
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x))
    else url.searchParams.set(k, String(v))
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${RENDER_KEY}`, Accept: 'application/json' },
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text }
  }
  if (!res.ok) throw new Error(`Render ${path} ${res.status}: ${JSON.stringify(json).slice(0, 300)}`)
  return json
}

async function discoverWorkspaceAndServices() {
  const owners = await renderFetch('/owners', { limit: 100 })
  const ownerList = (owners || []).map((o) => o.owner || o).filter(Boolean)
  const ownerId =
    process.env.RENDER_OWNER_ID?.trim() ||
    ownerList[0]?.id ||
    ownerList[0]?.owner?.id

  const services = await renderFetch('/services', { limit: 100 })
  const list = (services || []).map((s) => s.service || s)
  const api =
    list.find((s) => s.name === 'osmani-admin-api') ||
    list.find((s) => String(s.name || '').includes('admin-api'))
  const mpya = list.find((s) => s.name === 'osmani-admin-mpya')
  const pg = list.filter((s) => s.type === 'postgres' || String(s.name || '').includes('postgres'))

  return { ownerId, ownerList, services: list, apiService: api, staticService: mpya, postgres: pg }
}

async function metricsBandwidth(resourceIds, startTime, endTime) {
  if (!resourceIds.length) return { mb: 0, raw: null }
  const raw = await renderFetch('/metrics/bandwidth', {
    resource: resourceIds,
    startTime,
    endTime,
  })
  return { mb: sumMetricSeries(raw), raw }
}

async function metricsBandwidthSources(resourceIds, startTime, endTime) {
  const raw = await renderFetch('/metrics/bandwidth-sources', {
    resource: resourceIds,
    startTime,
    endTime,
  })
  return { ...sumBandwidthSources(raw), raw }
}

async function metricsDisk(resourceIds, startTime, endTime) {
  const raw = await renderFetch('/metrics/disk-usage', {
    resource: resourceIds,
    startTime,
    endTime,
  })
  return { mb: sumMetricSeries(raw), raw }
}

async function countRequestLogs(ownerId, resourceId, startTime, endTime, pathGlob) {
  let total = 0
  let cursorStart = startTime
  let cursorEnd = endTime
  let pages = 0
  const maxPages = 50
  while (pages < maxPages) {
    const q = {
      ownerId,
      resource: [resourceId],
      type: ['request'],
      path: [pathGlob],
      startTime: cursorStart,
      endTime: cursorEnd,
      limit: 100,
      direction: 'backward',
    }
    const page = await renderFetch('/logs', q)
    const logs = page.logs || []
    total += logs.length
    if (!page.hasMore) break
    cursorEnd = page.nextEndTime
    cursorStart = page.nextStartTime
    pages += 1
  }
  return total
}

async function bunnyBandwidth(startIso, endIso) {
  if (!BUNNY_KEY) return { ok: false, reason: 'BUNNY_API_KEY not set' }
  let zoneId = String(process.env.BUNNY_PULL_ZONE_ID || '').trim()
  if (!zoneId) {
    const zones = await fetch('https://api.bunny.net/pullzone?perPage=1000', {
      headers: { AccessKey: BUNNY_KEY },
    }).then((r) => r.json())
    const match = (Array.isArray(zones) ? zones : zones?.Items || []).find((z) =>
      JSON.stringify(z).toLowerCase().includes('osmanitv'),
    )
    zoneId = match?.Id ? String(match.Id) : ''
  }
  if (!zoneId) return { ok: false, reason: 'pull zone not found' }

  const params = new URLSearchParams({
    pullZone: zoneId,
    dateFrom: startIso,
    dateTo: endIso,
    hourly: 'true',
  })
  const res = await fetch(`https://api.bunny.net/statistics?${params}`, {
    headers: { AccessKey: BUNNY_KEY },
  })
  const body = await res.json()
  if (!res.ok) return { ok: false, status: res.status, body }

  let bytes = 0
  const rows = Array.isArray(body) ? body : body?.Graphs || []
  for (const row of rows) {
    if (row.BandwidthUsedChart) {
      for (const v of row.BandwidthUsedChart) bytes += Number(v) || 0
    }
    bytes += Number(row.BandwidthUsed || 0)
  }
  return { ok: true, zoneId, bytes, gb: bytes / 1e9, raw: body }
}

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

function planMonthlyUsd(service) {
  const plan = String(service?.serviceDetails?.plan || service?.plan || '').toLowerCase()
  const type = String(service?.type || '').toLowerCase()
  if (type === 'static_site') return 0
  if (plan.includes('pro')) return 85
  if (plan.includes('standard')) return 25
  if (plan.includes('starter')) return 7
  return null
}

async function productionStreamMetrics() {
  try {
    const sd = await fetch(`${API}/api/health/stream-delivery`).then((r) => r.json())
    return sd.metrics || null
  } catch {
    return null
  }
}

function attributeBandwidthByCategory(logCounts, totalGb, byteWeights) {
  const cats = {
    bein_ycn_proxy: { paths: ['/stream-proxy*', '/stream-direct*'], count: 0, weight: byteWeights.stream },
    uploads_images: { paths: ['/uploads*'], count: 0, weight: byteWeights.uploads },
    api_json: { paths: ['/api*'], count: 0, weight: byteWeights.api },
    other: { paths: ['*'], count: 0, weight: byteWeights.other },
  }
  cats.bein_ycn_proxy.count = (logCounts['/stream-proxy'] || 0) + (logCounts['/stream-direct'] || 0)
  cats.uploads_images.count = logCounts['/uploads'] || 0
  cats.api_json.count = logCounts['/api'] || 0

  const weighted =
    cats.bein_ycn_proxy.count * cats.bein_ycn_proxy.weight +
    cats.uploads_images.count * cats.uploads_images.weight +
    cats.api_json.count * cats.api_json.weight
  const alloc = {}
  for (const [k, c] of Object.entries(cats)) {
    const share = weighted > 0 ? (c.count * c.weight) / weighted : 0
    alloc[k] = {
      request_count_mtd_sample: c.count,
      estimated_gb: Number((totalGb * share).toFixed(4)),
      share_pct: `${(share * 100).toFixed(1)}%`,
    }
  }
  return alloc
}

// --- main ---
if (!RENDER_KEY) {
  console.error(
    JSON.stringify(
      {
        error: 'RENDER_API_KEY is required for billing-grade audit',
        hint: 'Create API key at https://dashboard.render.com/u/settings#api-keys',
        partial: {
          render_bandwidth_charge_usd_if_2_55: 2.55,
          implied_overage_gb_at_0_15: Number((2.55 / BW_USD_PER_GB).toFixed(3)),
          note: 'Set RENDER_INCLUDED_BANDWIDTH_GB to compute total egress from overage charge',
        },
      },
      null,
      2,
    ),
  )
  process.exit(1)
}

const snapshot = loadBillingSnapshot()
const discovered = await discoverWorkspaceAndServices()
const apiId =
  process.env.RENDER_SERVICE_ID?.trim() || discovered.apiService?.id || discovered.apiService?.service?.id
const resourceIds = [
  apiId,
  discovered.staticService?.id,
  ...discovered.postgres.map((p) => p.id),
].filter(Boolean)

const bw24 = await metricsBandwidth(resourceIds, start24h, endNow)
const bwMtd = await metricsBandwidth(resourceIds, startMtd, endNow)
const bwSrc24 = await metricsBandwidthSources([apiId].filter(Boolean), start24h, endNow)
const bwSrcMtd = await metricsBandwidthSources([apiId].filter(Boolean), startMtd, endNow)
const diskMtd = apiId ? await metricsDisk([apiId], startMtd, endNow) : { mb: 0 }

const bunny24 = await bunnyBandwidth(start24h, endNow)
const bunnyMtd = await bunnyBandwidth(startMtd, endNow)

const logCounts = {}
if (discovered.ownerId && apiId) {
  for (const [label, glob] of [
    ['/stream-proxy', '/stream-proxy*'],
    ['/stream-direct', '/stream-direct*'],
    ['/uploads', '/uploads*'],
    ['/api', '/api*'],
    ['/hls/seg', '/hls/seg*'],
  ]) {
    try {
      logCounts[label] = await countRequestLogs(discovered.ownerId, apiId, startMtd, endNow, glob)
    } catch (e) {
      logCounts[label] = { error: String(e.message) }
    }
  }
}

const renderGb24 = gbFromMb(bw24.mb)
const renderGbMtd = gbFromMb(bwMtd.mb)
const renderGbDay = renderGb24 / (HOURS / 24)
const bunnyGb24 = bunny24.ok ? bunny24.gb : 0
const bunnyGbMtd = bunnyMtd.ok ? bunnyMtd.gb : 0
const bunnyGbDay = bunny24.ok ? bunnyGb24 : 0
const totalGb24 = renderGb24 + bunnyGb24
const renderPct = totalGb24 > 0 ? (100 * renderGb24) / totalGb24 : 100

const overageGbMtd = Math.max(0, renderGbMtd - INCLUDED_GB)
const computedBandwidthUsd = overageGbMtd * BW_USD_PER_GB

const streamMetrics = await productionStreamMetrics()
const byteWeights = { stream: 550000, uploads: 50000, api: 5000, other: 10000 }
const categoryAlloc = attributeBandwidthByCategory(logCounts, renderGbMtd, byteWeights)

const serviceLines = discovered.services.map((s) => ({
  name: s.name,
  id: s.id,
  type: s.type,
  plan: s.serviceDetails?.plan || s.plan,
  est_compute_usd_month: planMonthlyUsd(s),
}))

const report = {
  generatedAt: new Date().toISOString(),
  methodology: {
    render_billing_api: 'NOT AVAILABLE — use Dashboard → Billing for authoritative invoice lines',
    render_metrics_bandwidth: 'GET /v1/metrics/bandwidth (hourly points, summed; values treated as MB per Render docs examples)',
    render_metrics_bandwidth_sources: 'GET /v1/metrics/bandwidth-sources (http|websocket|nat|privatelink)',
    category_attribution:
      'MTD request log counts by path × category byte weight (stream-proxy/direct weighted ~550KB, uploads ~50KB, api ~5KB). Not byte-metered per request in Render logs.',
    bunny: 'GET /api.bunny.net/statistics pullZone hourly BandwidthUsedChart',
  },
  dashboard_snapshot: snapshot,
  workspace: { ownerId: discovered.ownerId, services: serviceLines },
  egress: {
    last_24h: {
      render_gb: Number(renderGb24.toFixed(4)),
      bunny_gb: Number(bunnyGb24.toFixed(4)),
      total_gb: Number(totalGb24.toFixed(4)),
      render_pct: `${renderPct.toFixed(1)}%`,
      bunny_pct: `${(100 - renderPct).toFixed(1)}%`,
    },
    per_day: {
      render_gb_per_day: Number(renderGbDay.toFixed(4)),
      bunny_gb_per_day: Number(bunnyGbDay.toFixed(4)),
    },
    month_to_date: {
      render_gb: Number(renderGbMtd.toFixed(4)),
      bunny_gb: Number(bunnyGbMtd.toFixed(4)),
      render_bandwidth_sources_24h_mb: bwSrc24,
      render_bandwidth_sources_mtd_mb: bwSrcMtd,
    },
  },
  bandwidth_billing: {
    included_gb_assumption: INCLUDED_GB,
    mtd_overage_gb_computed: Number(overageGbMtd.toFixed(4)),
    mtd_bandwidth_usd_computed_at_0_15: Number(computedBandwidthUsd.toFixed(2)),
    user_reported_bandwidth_usd_2_55: {
      implied_overage_gb: Number((2.55 / BW_USD_PER_GB).toFixed(3)),
      total_egress_if_hobby_5gb_included: Number((2.55 / BW_USD_PER_GB + 5).toFixed(3)),
      total_egress_if_pro_25gb_included: Number((2.55 / BW_USD_PER_GB + 25).toFixed(3)),
    },
  },
  bandwidth_by_category_mtd: categoryAlloc,
  production_stream_counters: streamMetrics,
  log_request_counts_mtd: logCounts,
  largest_bill_driver: null,
  scale_cost_from_mtd_per_day: null,
}

const streamGb = categoryAlloc.bein_ycn_proxy?.estimated_gb || 0
const uploadGb = categoryAlloc.uploads_images?.estimated_gb || 0
const apiGb = categoryAlloc.api_json?.estimated_gb || 0
const ranked = [
  { name: 'Bein/ycn (stream-direct + stream-proxy)', gb: streamGb },
  { name: 'Images/uploads (/uploads)', gb: uploadGb },
  { name: 'API JSON (/api)', gb: apiGb },
].sort((a, b) => b.gb - a.gb)
report.largest_bill_driver = ranked[0]
report.bandwidth_ranked = ranked

const dailyGb = renderGbDay + bunnyGbDay
const daysInMonth = 30
const scale = (users, baseUsers = 1) => {
  const factor = users / baseUsers
  const gbMonth = dailyGb * daysInMonth * factor
  const bwUsd = Math.max(0, gbMonth - INCLUDED_GB) * BW_USD_PER_GB
  const compute = serviceLines.reduce((s, x) => s + (x.est_compute_usd_month || 0), 0)
  return {
    users,
    est_gb_month: Number(gbMonth.toFixed(1)),
    est_bandwidth_usd: Number(bwUsd.toFixed(2)),
    est_total_usd_with_compute: Number((compute + bwUsd).toFixed(2)),
  }
}
report.scale_cost_from_mtd_per_day = [1000, 5000, 10000, 50000].map((u) => scale(u))

console.log(JSON.stringify(report, null, 2))
