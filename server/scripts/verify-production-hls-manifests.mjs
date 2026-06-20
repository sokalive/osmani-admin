/**
 * Production HLS manifest verifier — inspects playback URLs and rewritten segment lines.
 * Usage: node scripts/verify-production-hls-manifests.mjs
 */
import fs from 'node:fs'
import https from 'node:https'
import http from 'node:http'

const API = process.env.API_BASE || 'https://osmani-admin-api.onrender.com'
const MAX_CHANNELS = Number(process.env.VERIFY_MAX_CHANNELS) || 6

function fetchText(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http
    const req = lib.get(
      url,
      { timeout: 25_000, headers: { 'User-Agent': 'OsmaniHlsVerify/1.0', Accept: '*/*' } },
      (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
          const loc = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, url).href
          return resolve(fetchText(loc, maxRedirects - 1))
        }
        let body = ''
        res.on('data', (c) => {
          body += c
        })
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body,
            url: res.responseUrl || url,
          }),
        )
      },
    )
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('timeout'))
    })
  })
}

function head(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http
    const req = lib.request(
      url,
      { method: 'HEAD', timeout: 20_000, headers: { 'User-Agent': 'OsmaniHlsVerify/1.0' } },
      (res) => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          url,
        })
      },
    )
    req.on('error', (e) => resolve({ status: 'ERR', error: e.message, url }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ status: 'TIMEOUT', url })
    })
    req.end()
  })
}

function classifyUrl(u) {
  if (!u || u.startsWith('data:')) return 'data'
  if (u.includes('/stream-proxy')) return 'render_proxy'
  if (u.includes('/stream-direct')) return 'render_direct'
  if (u.includes('/hls/seg?') && u.includes('.b-cdn.net')) return 'bunny_seg'
  if (u.includes('.b-cdn.net')) return 'bunny_other'
  if (u.includes('onrender.com')) return 'render_other'
  return 'upstream_raw'
}

function tryAbs(u, base) {
  try {
    return new URL(u, base).href
  } catch {
    return u
  }
}

function extractManifestUrls(text, base) {
  const urls = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    if (t.startsWith('#')) {
      const m = t.match(/URI="([^"]+)"/i)
      if (m) urls.push({ kind: 'attr', tag: t.slice(0, 24), url: tryAbs(m[1], base) })
      continue
    }
    urls.push({ kind: 'media', url: tryAbs(t, base) })
  }
  return urls
}

function tally(urls) {
  const counts = {}
  for (const u of urls) {
    const c = classifyUrl(u.url)
    counts[c] = (counts[c] || 0) + 1
  }
  return counts
}

async function analyzeChannel(ch) {
  const out = {
    id: ch.id,
    name: ch.name,
    playbackUrl: ch.playbackUrl,
    stream_delivery_effective: ch.stream_delivery_effective,
    direct_stream_url: ch.direct_stream_url || null,
  }
  if (!ch.playbackUrl) {
    out.error = 'no playbackUrl'
    return out
  }
  out.playback_entry_class = classifyUrl(ch.playbackUrl)

  let master
  try {
    master = await fetchText(ch.playbackUrl)
  } catch (e) {
    out.error = `manifest_fetch: ${e.message}`
    return out
  }
  out.master_http_status = master.status
  const base = master.url || ch.playbackUrl
  const masterUrls = extractManifestUrls(master.body, base)
  out.master_line_counts = tally(masterUrls)
  out.master_is_extm3u = master.body.includes('#EXTM3U')

  const mediaLines = masterUrls.filter((u) => u.kind === 'media')
  const attrLines = masterUrls.filter((u) => u.kind === 'attr')
  out.master_media_samples = mediaLines.slice(0, 3).map((u) => u.url)
  out.master_attr_samples = attrLines.slice(0, 3).map((u) => ({ tag: u.tag, url: u.url }))

  const variantLine = mediaLines.find((u) => /\.m3u8(\?|$)/i.test(u.url))
  if (!variantLine) {
    out.note = 'master has no variant m3u8 line (may be media playlist already)'
    const segLine = mediaLines.find((u) => /\.(ts|m4s)(\?|$)/i.test(u.url))
    if (segLine) {
      out.segment_probe = await head(segLine.url)
      out.segment_probe_class = classifyUrl(segLine.url)
    }
    return out
  }

  out.variant_playlist_entry_class = classifyUrl(variantLine.url)
  let variant
  try {
    variant = await fetchText(variantLine.url)
  } catch (e) {
    out.variant_error = e.message
    return out
  }
  out.variant_http_status = variant.status
  const vbase = variant.url || variantLine.url
  const variantUrls = extractManifestUrls(variant.body, vbase)
  out.variant_line_counts = tally(variantUrls)
  const vMedia = variantUrls.filter((u) => u.kind === 'media')
  const vAttr = variantUrls.filter((u) => u.kind === 'attr')
  out.variant_media_samples = vMedia.slice(0, 5).map((u) => u.url)
  out.variant_attr_samples = vAttr.slice(0, 3).map((u) => ({ tag: u.tag, url: u.url }))

  const segLine = vMedia.find((u) => /\.(ts|m4s)(\?|$)/i.test(u.url))
  if (segLine) {
    const h = await head(segLine.url)
    out.segment_probe = {
      url: segLine.url,
      class: classifyUrl(segLine.url),
      status: h.status,
      server: h.headers?.server,
      cache_control: h.headers?.['cache-control'],
      cdn_cache: h.headers?.['cdn-cache'] || h.headers?.['cdn-cache-status'],
      x_cache: h.headers?.['x-cache'],
      age: h.headers?.age,
    }
  }
  return out
}

async function main() {
  const healthRes = await fetchText(`${API}/api/health/stream-delivery`)
  const health = JSON.parse(healthRes.body)

  const chRes = await fetchText(`${API}/api/channels`)
  const channels = JSON.parse(chRes.body)
  const live = channels
    .filter((c) => c.isActive !== false && c.showInApp !== false && c.playbackUrl)
    .slice(0, MAX_CHANNELS)

  const results = []
  for (const ch of live) {
    results.push(await analyzeChannel(ch))
    await new Promise((r) => setTimeout(r, 400))
  }

  let totalLines = 0
  let bunnySeg = 0
  let renderProxy = 0
  for (const r of results) {
    for (const block of [r.master_line_counts, r.variant_line_counts]) {
      if (!block) continue
      for (const [k, n] of Object.entries(block)) {
        totalLines += n
        if (k === 'bunny_seg') bunnySeg += n
        if (k === 'render_proxy') renderProxy += n
      }
    }
  }

  const report = {
    verified_at: new Date().toISOString(),
    api_base: API,
    production_config: {
      stream_segment_delivery: health.segments?.stream_segment_delivery,
      production_segment_offload_active: health.segments?.production_segment_offload_active,
      playback_force_proxy: health.playback_force_proxy,
      signing_enabled: health.signing_enabled,
      metrics: health.metrics,
    },
    channels_in_api: channels.length,
    channels_analyzed: results.length,
    manifest_url_summary: {
      total_manifest_lines_classified: totalLines,
      bunny_segment_lines: bunnySeg,
      render_stream_proxy_lines: renderProxy,
      estimated_segment_offload_percent:
        totalLines > 0 ? Math.round((bunnySeg / totalLines) * 1000) / 10 : 0,
    },
    per_channel: results,
    conclusion:
      bunnySeg > 0 && renderProxy === 0
        ? 'Bunny segment offload active in sampled manifests'
        : renderProxy > 0 && bunnySeg === 0
          ? 'Segments still rewritten to Render stream-proxy — Bunny offload NOT active in production'
          : 'Mixed or incomplete manifest sampling',
  }

  console.log(JSON.stringify(report, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
