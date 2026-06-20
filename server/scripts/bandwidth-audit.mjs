/**
 * Bandwidth audit — Render + Bunny APIs (when keyed) + production byte model.
 *
 * Env (optional but required for exact 24h GB):
 *   RENDER_API_KEY          Render account API key
 *   RENDER_SERVICE_ID       osmani-admin-api service id (srv-…)
 *   BUNNY_API_KEY           Bunny account API key
 *   BUNNY_PULL_ZONE_ID      Pull zone id for osmanitv.b-cdn.net (or auto-list)
 *   API_BASE                https://osmani-admin-api.onrender.com
 */
import assert from 'node:assert/strict'

const API = (process.env.API_BASE || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const HOURS = Number(process.env.AUDIT_HOURS) || 24
const now = Date.now()
const startMs = now - HOURS * 3600 * 1000

function gb(bytes) {
  return Number(bytes || 0) / 1e9
}

function fmtGb(bytes) {
  return `${gb(bytes).toFixed(3)} GB`
}

function pct(part, total) {
  if (!total) return '0.0%'
  return `${((100 * part) / total).toFixed(1)}%`
}

function classifyProvider(url, host = '') {
  const u = String(url || host || '').toLowerCase()
  if (u.includes('ycn-redirect')) return 'ycn-redirect.com'
  if (u.includes('loadcore')) return 'loadcore.online'
  if (u.includes('netstack')) return 'netstack.online'
  if (u.includes('lanexa')) return 'lanexa.online'
  if (u.includes('netvidra')) return 'netvidra.online'
  if (u.includes('mpingotv')) return 'mpingotv'
  if (u.includes('akamaized') || u.includes('cloudfront') || u.includes('fastly')) return 'public_cdn'
  return 'other'
}

function rollupYcnFamily(host) {
  const p = classifyProvider('', host)
  if (['loadcore.online', 'netstack.online', 'lanexa.online', 'netvidra.online', 'ycn-redirect.com'].includes(p)) {
    return p
  }
  if (host.endsWith('.online')) return 'other.online (ycn hop)'
  return p
}

async function fetchRenderBandwidth() {
  const key = String(process.env.RENDER_API_KEY || '').trim()
  const resource = String(process.env.RENDER_SERVICE_ID || process.env.RENDER_SERVICE || '').trim()
  if (!key || !resource) return { ok: false, reason: 'RENDER_API_KEY or RENDER_SERVICE_ID not set' }

  const params = new URLSearchParams({
    resource,
    startTime: String(Math.floor(startMs / 1000)),
    endTime: String(Math.floor(now / 1000)),
  })
  const res = await fetch(`https://api.render.com/v1/bandwidth?${params}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
  })
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  if (!res.ok) return { ok: false, status: res.status, body }
  return { ok: true, body }
}

async function fetchBunnyBandwidth() {
  const key = String(process.env.BUNNY_API_KEY || process.env.BUNNY_ACCOUNT_API_KEY || '').trim()
  if (!key) return { ok: false, reason: 'BUNNY_API_KEY not set' }

  let zoneId = String(process.env.BUNNY_PULL_ZONE_ID || process.env.BUNNY_ZONE_ID || '').trim()
  if (!zoneId) {
    const list = await fetch('https://api.bunny.net/pullzone?perPage=1000', {
      headers: { AccessKey: key },
    })
    const zones = await list.json()
    const match = (Array.isArray(zones) ? zones : zones?.Items || []).find((z) =>
      String(z.Hostnames || z.Name || '')
        .toLowerCase()
        .includes('osmanitv'),
    )
    zoneId = match?.Id ? String(match.Id) : ''
  }
  if (!zoneId) return { ok: false, reason: 'BUNNY_PULL_ZONE_ID not set and osmanitv zone not found' }

  const dateFrom = new Date(startMs).toISOString()
  const dateTo = new Date(now).toISOString()
  const params = new URLSearchParams({ pullZone: zoneId, dateFrom, dateTo, hourly: 'true' })
  const res = await fetch(`https://api.bunny.net/statistics?${params}`, {
    headers: { AccessKey: key },
  })
  const body = await res.json()
  if (!res.ok) return { ok: false, status: res.status, body }

  let bytes = 0
  for (const row of body || []) {
    bytes += Number(row.BandwidthUsedChart?.reduce((a, b) => a + Number(b), 0) || row.BandwidthUsed || 0)
  }
  if (!bytes && body.TotalBandwidthUsed) bytes = Number(body.TotalBandwidthUsed)
  return { ok: true, zoneId, bytes, raw: body }
}

async function sampleStreamBytes() {
  const exo = {
    'User-Agent': 'ExoPlayerLib/2.19.1',
    Accept: '*/*',
    Origin: 'null',
  }
  const channels = await fetch(`${API}/api/channels`).then((r) => r.json())
  const out = []
  for (const c of channels) {
    if (!c.playbackUrl) continue
    try {
      const mr = await fetch(c.playbackUrl, { headers: exo })
      const manifest = await mr.text()
      const prov = classifyProvider(c.url)
      if (!manifest.startsWith('#EXTM3U')) {
        out.push({ channelId: c.id, name: c.name, provider: prov, manifestBytes: manifest.length, hls: false })
        continue
      }
      const lines = manifest.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'))
      let segBytes = 0
      if (lines[0]) {
        const sr = await fetch(lines[0], { headers: exo })
        segBytes = (await sr.arrayBuffer()).byteLength
      }
      out.push({
        channelId: c.id,
        name: c.name,
        provider: prov,
        hls: true,
        manifestBytes: manifest.length,
        segLines: lines.length,
        proxyLines: (manifest.match(/stream-proxy/g) || []).length,
        bunnyLines: (manifest.match(/b-cdn\.net/g) || []).length,
        sampleSegBytes: segBytes,
      })
    } catch (e) {
      out.push({ channelId: c.id, name: c.name, error: String(e.message || e) })
    }
  }
  return out
}

function modelFromMetrics(metrics, samples) {
  const routes = metrics?.segment_routes_by_provider || {}
  const routeTotal = Object.values(routes).reduce((s, r) => s + Number(r.total || 0), 0)
  const byProvider = {}
  for (const [host, r] of Object.entries(routes)) {
    const p = rollupYcnFamily(host)
    byProvider[p] = (byProvider[p] || 0) + Number(r.total || 0)
  }

  const ycnSamples = samples.filter((s) => s.hls && s.provider === 'ycn-redirect.com' && s.sampleSegBytes)
  const avgSeg =
    ycnSamples.reduce((s, x) => s + x.sampleSegBytes, 0) / Math.max(1, ycnSamples.length)
  const avgManifest =
    ycnSamples.reduce((s, x) => s + x.manifestBytes, 0) / Math.max(1, ycnSamples.length)

  const directReq = Number(metrics?.direct_requests || 0)
  const proxyReq = Number(metrics?.proxy_requests || 0)
  const bunnySeg = Number(metrics?.segment_urls_bunny || 0)
  const proxySeg = Number(metrics?.segment_urls_proxy || 0)
  const segTotal = bunnySeg + proxySeg || 1

  return {
    routeTotal,
    byProvider,
    avgSegBytes: Math.round(avgSeg),
    avgManifestBytes: Math.round(avgManifest),
    streamPathPct: {
      render_proxy_segments: pct(proxySeg, segTotal),
      bunny_segments: pct(bunnySeg, segTotal),
    },
    countersSinceRestart: {
      direct_manifest_requests: directReq,
      proxy_manifest_requests: proxyReq,
      segment_urls_proxy: proxySeg,
      segment_urls_bunny: bunnySeg,
      bunny_origin_pull_ok: Number(metrics?.bunny_origin_fetch_ok || 0),
    },
  }
}

function estimateMonthlyCost(users, gbPerUserMonth, renderPerGb = 0.15, bunnyPerGb = 0.01, baseRender = 7) {
  const totalGb = users * gbPerUserMonth
  const renderGb = totalGb * 0.95
  const bunnyGb = totalGb * 0.05
  return {
    users,
    totalGbMonth: Math.round(totalGb),
    estUsdMonth: Math.round((baseRender + renderGb * renderPerGb + bunnyGb * bunnyPerGb) * 100) / 100,
  }
}

// --- run ---
const [health, sd, overview, channels] = await Promise.all([
  fetch(`${API}/api/health`).then((r) => r.json()),
  fetch(`${API}/api/health/stream-delivery`).then((r) => r.json()),
  fetch(`${API}/api/analytics/overview`).then((r) => r.json()),
  fetch(`${API}/api/channels`).then((r) => r.json()),
])

const renderBw = await fetchRenderBandwidth()
const bunnyBw = await fetchBunnyBandwidth()
const samples = await sampleStreamBytes()
const model = modelFromMetrics(sd.metrics, samples)

const channelCatalog = {}
for (const c of channels) {
  const p = classifyProvider(c.url)
  channelCatalog[p] = (channelCatalog[p] || 0) + 1
}

const rankedHosts = Object.entries(sd.metrics?.segment_routes_by_provider || {})
  .map(([host, r]) => ({ host, total: r.total, proxy: r.proxy, bunny: r.bunny, provider: rollupYcnFamily(host) }))
  .sort((a, b) => b.total - a.total)

const rankedProviders = Object.entries(model.byProvider)
  .map(([provider, weight]) => ({ provider, manifestSegmentLines: weight, share: pct(weight, model.routeTotal) }))
  .sort((a, b) => b.manifestSegmentLines - a.manifestSegmentLines)

// Per-viewer-hour model (ycn): ~1 manifest/6s + 1 segment/6s
const segPerHour = 3600 / 6
const bytesPerViewerHour = segPerHour * (model.avgSegBytes + model.avgManifestBytes)

const userScenarios = [500, 1000, 5000, 10000, 50000].map((users) => {
  const hoursPerUserMonth = 60
  const gbMonth = (users * hoursPerUserMonth * bytesPerViewerHour) / 1e9
  return estimateMonthlyCost(users, gbMonth / users)
})

const report = {
  generatedAt: new Date().toISOString(),
  windowHours: HOURS,
  production: { commit: health.commit?.slice(0, 7), totalInstalls: overview.totalInstalls, onlineNow: overview.onlineNow },
  exactBilling: {
    render24h: renderBw.ok ? renderBw.body : { unavailable: renderBw.reason || renderBw },
    bunny24h: bunnyBw.ok ? { zoneId: bunnyBw.zoneId, bytes: bunnyBw.bytes, gb: gb(bunnyBw.bytes) } : { unavailable: bunnyBw.reason || bunnyBw },
  },
  observedStreamPath: model.streamPathPct,
  countersSinceApiRestart: model.countersSinceRestart,
  channelCatalog,
  byteSamples: samples,
  providerRankingBySegmentLines: rankedProviders,
  hostRanking: rankedHosts,
  model: {
    avgYcnSegmentBytes: model.avgSegBytes,
    avgYcnManifestBytes: model.avgManifestBytes,
    estBytesPerViewerHourYcn: bytesPerViewerHour,
    estGbPerViewerHourYcn: gb(bytesPerViewerHour),
  },
  costScenariosYcnHeavy: userScenarios,
  notes: [
    'Exact 24h GB requires RENDER_API_KEY + RENDER_SERVICE_ID and BUNNY_API_KEY in env.',
    'segment_routes_by_provider counts manifest rewrite lines since last deploy, not HTTP bytes.',
    'mpingotv channels return HTML player pages on /stream-direct — not HLS via this proxy path.',
  ],
}

console.log(JSON.stringify(report, null, 2))
