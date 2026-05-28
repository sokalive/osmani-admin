/**
 * Production trace for Bein/ycn stream paths.
 * Usage: node scripts/trace-bein-production.mjs [channelId]
 */
import assert from 'node:assert/strict'

const API = (process.env.API_BASE || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const CHANNEL_ID = Number(process.argv[2]) || 16

function classifyUpstream(status, ct, body) {
  const preview = String(body || '').slice(0, 200)
  if (status === 0) return 'timeout_or_network'
  if (status >= 500) return 'upstream_5xx'
  if (status === 403 && /cloudflare|cf-ray|just a moment/i.test(preview)) return '403_cloudflare_html'
  if (status === 403) return '403_other'
  if (status === 503) return '503'
  if (preview.startsWith('#EXTM3U')) return '200_m3u8'
  if (preview.startsWith('<')) return `${status}_html`
  if (preview.startsWith('G@') || preview.includes('\u0000')) return `${status}_binary_ts_or_js`
  return `${status}_unknown`
}

async function probe(label, url, headers = {}) {
  const started = Date.now()
  let status = 0
  let ct = ''
  let body = ''
  let err = ''
  try {
    const r = await fetch(url, { headers, redirect: 'follow' })
    status = r.status
    ct = r.headers.get('content-type') || ''
    body = await r.text()
  } catch (e) {
    err = String(e.message || e)
  }
  const is500 = status === 500 && /internal server error/i.test(body)
  const layer = classifyUpstream(status, ct, body)
  return {
    label,
    url: url.slice(0, 120),
    status,
    is_express_500: is500,
    content_type: ct,
    layer,
    error: err || null,
    elapsed_ms: Date.now() - started,
    body_preview: body.slice(0, 160).replace(/\s+/g, ' '),
    extm3u: body.trimStart().startsWith('#EXTM3U'),
    proxy_lines: (body.match(/stream-proxy/g) || []).length,
    bunny_lines: (body.match(/b-cdn\.net\/hls\/seg/g) || []).length,
  }
}

const channels = await fetch(`${API}/api/channels`).then((r) => r.json())
const ch = channels.find((c) => c.id === CHANNEL_ID)
if (!ch) {
  console.error('channel not found', CHANNEL_ID)
  process.exit(1)
}

const exoHeaders = {
  Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,video/*,*/*',
  'User-Agent': 'ExoPlayerLib/2.19.1 (Linux;Android 13) ExoPlayer',
  Range: 'bytes=0-',
}

const results = []
results.push(
  await probe('stream-direct (Exo)', ch.playbackUrl, exoHeaders),
)
if (ch.proxy_playback_url) {
  results.push(await probe('stream-proxy (Exo)', ch.proxy_playback_url, exoHeaders))
}

const directProbe = results.find((r) => r.label.includes('stream-direct'))
const manifest = results.find((r) => r.extm3u)
if (manifest) {
  const full = await fetch(manifest.label.includes('direct') ? ch.playbackUrl : ch.proxy_playback_url, {
    headers: exoHeaders,
  }).then((r) => r.text())
  const mediaLines = full.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'))
  for (const line of mediaLines.slice(0, 4)) {
    results.push(await probe(`segment ${results.length}`, line.trim(), exoHeaders))
  }
}

const health = await fetch(`${API}/api/health/stream-delivery`)
  .then((r) => r.json())
  .catch(() => ({}))

console.log(
  JSON.stringify(
    {
      channel: { id: ch.id, name: ch.name, upstream: ch.url },
      deploy: health.deploy || health.git || null,
      stream_delivery: health.stream_segment_delivery || health,
      probes: results,
      manifest_routing: directProbe
        ? { bunny_lines: directProbe.bunny_lines, proxy_lines: directProbe.proxy_lines }
        : null,
      diagnosis: results.some((r) => r.is_express_500)
        ? 'Express 500 — check Render logs for [stream-proxy] scope runtime_error or stream_body_locked'
        : results.some((r) => r.layer.includes('cloudflare'))
          ? 'Cloudflare block on upstream — verify STREAM_YCN_UPSTREAM_USER_AGENT on Render'
          : directProbe && directProbe.bunny_lines > 0
            ? 'ycn segments still routed to Bunny — deploy selective-routing fix for child hosts'
            : directProbe && directProbe.proxy_lines > 0 && directProbe.bunny_lines === 0
              ? 'Bein manifest routing OK (proxy only, no Bunny segment URLs)'
              : 'manifest path OK from this probe IP',
    },
    null,
    2,
  ),
)

const direct = results[0]
assert.ok(!direct.is_express_500, `stream-direct returned Express 500: ${direct.body_preview}`)
assert.ok(direct.extm3u, 'stream-direct must return #EXTM3U')
assert.equal(direct.bunny_lines, 0, `expected bunny_lines=0, got ${direct.bunny_lines}`)
assert.ok(direct.proxy_lines > 0, `expected proxy_lines>0, got ${direct.proxy_lines}`)
