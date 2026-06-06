/**
 * Audit Mpingo player.php authorization metadata per upstream channel id.
 * Usage: node scripts/audit-mpingo-package-auth.mjs [apiBase]
 */
import assert from 'node:assert/strict'

const API = (process.argv[2] || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const UA =
  'Mozilla/5.0 (Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36'

const PACKAGE_PATTERNS = [
  /authorizedPackage(?:Name)?\s*[:=]\s*['"]([^'"]+)['"]/gi,
  /allowedPackage(?:s|Names?)?\s*[:=]\s*\[([^\]]+)\]/gi,
  /allowedPackage(?:s|Names?)?\s*[:=]\s*['"]([^'"]+)['"]/gi,
  /requiredPackage(?:Name)?\s*[:=]\s*['"]([^'"]+)['"]/gi,
  /packageName\s*[:=]\s*['"](com\.[^'"]+)['"]/gi,
  /appId\s*[:=]\s*['"](com\.[^'"]+)['"]/gi,
  /ANDROID_PACKAGE['"]?\s*[:=]\s*['"](com\.[^'"]+)['"]/gi,
  /"package"\s*:\s*"(com\.[^"]+)"/gi,
]

const AUTH_SIGNAL_PATTERNS = [
  /6001/gi,
  /authorized apps only/gi,
  /restricted to authorized/gi,
  /Detected ID/gi,
  /com\.sportstv[^'">\s]*/gi,
  /com\.burudanitv\.app/gi,
  /com\.[^'">\s]{3,}\.app/gi,
]

function upstreamChannelId(url) {
  try {
    const u = new URL(url)
    return u.searchParams.get('channel') || null
  } catch {
    return null
  }
}

function extractPackages(body) {
  const found = new Set()
  for (const re of PACKAGE_PATTERNS) {
    re.lastIndex = 0
    for (const m of body.matchAll(re)) {
      const raw = m[1] || m[0]
      const parts = String(raw)
        .split(/[,']/)
        .map((s) => s.replace(/[^a-z0-9._]/gi, '').trim())
        .filter((s) => s.startsWith('com.'))
      for (const p of parts) found.add(p)
    }
  }
  return [...found].sort()
}

function extractAuthSignals(body) {
  const signals = {}
  for (const re of AUTH_SIGNAL_PATTERNS) {
    re.lastIndex = 0
    const hits = [...body.matchAll(re)].map((m) => m[0]).slice(0, 8)
    if (hits.length) signals[re.source.slice(0, 40)] = [...new Set(hits)]
  }
  return signals
}

function extractAuthBlocks(body) {
  const blocks = []
  const re =
    /(?:authorizedPackage|allowedPackage|requiredPackage|packageName|6001|authorized apps)[^<\n]{0,300}/gi
  for (const m of body.matchAll(re)) {
    const line = m[0].replace(/\s+/g, ' ').trim()
    if (!blocks.includes(line)) blocks.push(line)
    if (blocks.length >= 6) break
  }
  return blocks
}

async function fetchMpingoPlayer(channelId) {
  const url = `https://nur.mpingotv.com/v3/player.php?channel=${channelId}`
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: 'https://nur.mpingotv.com',
      Origin: 'https://nur.mpingotv.com',
    },
  })
  const body = await r.text()
  return {
    url,
    status: r.status,
    bytes: body.length,
    contentType: r.headers.get('content-type'),
    packages: extractPackages(body),
    authSignals: extractAuthSignals(body),
    authBlocks: extractAuthBlocks(body),
    hasPlayerShell: /video|jwplayer|hls|m3u8|player/i.test(body),
    title: (body.match(/<title[^>]*>([^<]+)/i) || [])[1]?.trim() || null,
  }
}

async function fetchApiChannel(id) {
  const r = await fetch(`${API}/api/channels/${id}`)
  if (!r.ok) return null
  return r.json()
}

async function fetchProxiedPlayer(playbackUrl, proxyFallbackUrl) {
  const proxyUrl = proxyFallbackUrl || null
  if (!proxyUrl) return null
  const r = await fetch(proxyUrl, { headers: { 'User-Agent': UA } })
  const body = await r.text()
  return {
    status: r.status,
    bytes: body.length,
    packages: extractPackages(body),
    authSignals: extractAuthSignals(body),
    authBlocks: extractAuthBlocks(body),
    hasBaseTag: /data-osmani-mpingo-base/i.test(body),
  }
}

const channelsRes = await fetch(`${API}/api/channels`)
assert.equal(channelsRes.ok, true, `channels list ${channelsRes.status}`)
const channelsPayload = await channelsRes.json()
const allChannels = channelsPayload.channels || channelsPayload
const mpingoChannels = allChannels.filter((c) => /mpingotv\.com/i.test(c.url || ''))

const upstreamIds = [...new Set(mpingoChannels.map((c) => upstreamChannelId(c.url)).filter(Boolean))]
const upstreamById = new Map()
for (const id of upstreamIds.sort((a, b) => Number(a) - Number(b))) {
  upstreamById.set(id, await fetchMpingoPlayer(id))
}

const report = {
  api: API,
  audited_at: new Date().toISOString(),
  mpingo_channel_count: mpingoChannels.length,
  unique_upstream_ids: upstreamIds.length,
  channels: [],
}

for (const ch of mpingoChannels) {
  const upId = upstreamChannelId(ch.url)
  const upstream = upstreamById.get(upId)
  const apiDetail = await fetchApiChannel(ch.id)
  const proxied = await fetchProxiedPlayer(ch.playbackUrl, ch.proxy_fallback_url)

  report.channels.push({
    catalog_id: ch.id,
    name: ch.name,
    upstream_channel_id: upId,
    url: ch.url,
    playbackUrl: ch.playbackUrl,
    playerType: ch.playerType,
    proxy_fallback_url: ch.proxy_fallback_url || null,
    api_fields: apiDetail
      ? {
          authorizedPackageName: apiDetail.authorizedPackageName ?? null,
          playback_source: apiDetail.playback_source ?? null,
          stream_delivery_effective: apiDetail.stream_delivery_effective ?? null,
        }
      : null,
    upstream,
    proxied,
    backend_overrides_auth:
      apiDetail?.authorizedPackageName != null &&
      String(apiDetail.authorizedPackageName).trim() !== '',
  })
}

const byUpstream = new Map()
for (const row of report.channels) {
  const key = row.upstream_channel_id
  if (!byUpstream.has(key)) {
    byUpstream.set(key, {
      upstream_channel_id: key,
      upstream_url: row.upstream?.url,
      packages: row.upstream?.packages || [],
      auth_signals: row.upstream?.authSignals || {},
      catalog_entries: [],
    })
  }
  byUpstream.get(key).catalog_entries.push({ id: row.catalog_id, name: row.name })
}

report.upstream_summary = [...byUpstream.values()].sort(
  (a, b) => Number(a.upstream_channel_id) - Number(b.upstream_channel_id)
)

const ch1 = report.upstream_summary.find((u) => u.upstream_channel_id === '1')
const ch2 = report.upstream_summary.find((u) => u.upstream_channel_id === '2')
report.channel_1_vs_2 = {
  channel_1_packages: ch1?.packages || [],
  channel_2_packages: ch2?.packages || [],
  packages_differ:
    JSON.stringify(ch1?.packages || []) !== JSON.stringify(ch2?.packages || []),
  channel_1_auth_signals: ch1?.auth_signals || {},
  channel_2_auth_signals: ch2?.auth_signals || {},
}

report.backend_auth_override_any = report.channels.some((c) => c.backend_overrides_auth)
report.api_exposes_authorizedPackageName = report.channels.some(
  (c) => c.api_fields && 'authorizedPackageName' in c.api_fields && c.api_fields.authorizedPackageName != null
)

console.log(JSON.stringify(report, null, 2))
