/**
 * Full production audit: Mpingo effective playerType vs expected routing logic.
 * Usage: node scripts/audit-mpingo-routing-live.mjs [apiBase]
 */
import assert from 'node:assert/strict'
import { parseMpingoPlayerHtml } from '../src/lib/mpingoPlayerMetadata.js'

const API = (process.argv[2] || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const UA =
  'Mozilla/5.0 (Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36'

function upstreamChannelId(url) {
  try {
    return new URL(url).searchParams.get('channel')
  } catch {
    return null
  }
}

async function fetchUpstreamMeta(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://nur.mpingotv.com' },
  })
  const body = await r.text()
  return parseMpingoPlayerHtml(body)
}

function expectedPlayerType(meta) {
  if (!meta?.hasStreamUrl) return 'webview'
  if (meta?.hasClearKey) return 'webview'
  if (meta?.hasStreamUrl && !meta?.hasClearKey) return 'chrome'
  return 'webview'
}

const health = await fetch(`${API}/api/health`).then((r) => r.json())
const r = await fetch(`${API}/api/channels`)
assert.equal(r.ok, true)
const list = await r.json()
const mpingo = list.filter((c) => /mpingotv\.com/i.test(c.url || ''))

const uniqueUrls = [...new Set(mpingo.map((c) => c.url))]
const upstreamByUrl = new Map()
for (const url of uniqueUrls) {
  upstreamByUrl.set(url, await fetchUpstreamMeta(url))
}

const rows = []
let mismatches = 0

for (const ch of mpingo) {
  const up = upstreamByUrl.get(ch.url)
  const expected = expectedPlayerType(up)
  const match = ch.playerType === expected
  if (!match) mismatches += 1
  rows.push({
    id: ch.id,
    name: ch.name,
    upstream_channel: upstreamChannelId(ch.url),
    playerType: ch.playerType,
    player_type: ch.player_type,
    player_type_configured: ch.player_type_configured,
    use_chrome_player: ch.use_chrome_player,
    playback_source: ch.playback_source,
    expected_playerType: expected,
    routing_match: match,
    mpingo_drm: ch.mpingo_drm,
    upstream: {
      has_clear_key: Boolean(up?.hasClearKey),
      has_stream_url: Boolean(up?.hasStreamUrl),
      stream_type: up?.streamType || null,
    },
  })
}

const report = {
  api: API,
  verified_at: new Date().toISOString(),
  production_commit: health.commit || null,
  routing_epoch_header: r.headers.get('x-channels-routing-epoch'),
  config_version_header: r.headers.get('x-config-version'),
  mpingo_count: mpingo.length,
  routing_mismatches: mismatches,
  summary: {
    webview_clearkey: rows.filter((x) => x.expected_playerType === 'webview' && x.upstream.has_clear_key)
      .length,
    chrome_widevine: rows.filter((x) => x.expected_playerType === 'chrome').length,
    webview_inactive: rows.filter((x) => x.expected_playerType === 'webview' && !x.upstream.has_clear_key)
      .length,
  },
  channels: rows,
}

assert.equal(mismatches, 0, `routing mismatches: ${mismatches}`)
console.log(JSON.stringify(report, null, 2))
console.log('audit-mpingo-routing-live: OK')
