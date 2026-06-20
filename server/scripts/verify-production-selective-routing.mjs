/**
 * Production selective routing verifier — fetches live manifests per channel.
 */
import fs from 'node:fs'
import https from 'node:https'
import http from 'node:http'

const API = process.env.API_BASE || 'https://osmani-admin-api.onrender.com'
const MAX = Number(process.env.VERIFY_MAX_CHANNELS) || 20

function fetchText(url, headers = {}, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http
    const req = lib.get(
      url,
      {
        timeout: 28_000,
        headers: {
          'User-Agent': 'OsmaniProdVerify/1.0',
          Accept: '*/*',
          ...headers,
        },
      },
      (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
          const loc = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, url).href
          return resolve(fetchText(loc, headers, maxRedirects - 1))
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

function classify(u) {
  if (!u) return 'none'
  if (u.includes('/hls/seg?') && u.includes('.b-cdn.net')) return 'bunny_seg'
  if (u.includes('/stream-proxy')) return 'render_proxy'
  if (u.includes('/stream-direct')) return 'render_direct'
  if (u.includes('.b-cdn.net')) return 'bunny_other'
  if (u.includes('ycn-redirect') || u.includes('lanexa.online') || u.includes('netvidra')) return 'upstream_protected'
  if (u.startsWith('http')) return 'upstream_raw'
  return 'other'
}

function extractUrls(text, base) {
  const out = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    const attr = t.match(/URI="([^"]+)"/i)
    if (attr) {
      try {
        out.push(new URL(attr[1], base).href)
      } catch {
        out.push(attr[1])
      }
      continue
    }
    if (t.startsWith('#')) continue
    try {
      out.push(new URL(t, base).href)
    } catch {
      out.push(t)
    }
  }
  return out
}

function tally(urls) {
  const c = {}
  for (const u of urls) {
    const k = classify(u)
    c[k] = (c[k] || 0) + 1
  }
  return c
}

async function fetchManifestChain(entryUrl, hdr) {
  const chain = []
  let url = entryUrl
  for (let depth = 0; depth < 4; depth++) {
    const res = await fetchText(url, hdr)
    chain.push({ depth, url, status: res.status, ct: res.headers['content-type'], len: res.body.length })
    if (res.status !== 200) return { chain, urls: [], error: `http_${res.status}` }
    if (!res.body.includes('#EXTM3U')) {
      return { chain, urls: [], error: res.body.includes('<html') ? 'html_not_hls' : 'not_m3u8' }
    }
    const base = res.url || url
    const urls = extractUrls(res.body, base)
    const media = urls.filter((u) => /\.m3u8(\?|$)/i.test(u))
    const segments = urls.filter((u) => /\.(ts|m4s|aac)(\?|$)/i.test(u))
    if (segments.length > 0) {
      return { chain, urls, segments, media, finalBase: base }
    }
    if (media.length === 0) {
      return { chain, urls, error: 'no_media_lines' }
    }
    url = media[0]
  }
  return { chain, urls: [], error: 'max_depth' }
}

async function main() {
  const healthRes = await fetchText(`${API}/api/health/stream-delivery`)
  const health = JSON.parse(healthRes.body)
  const chRes = await fetchText(`${API}/api/channels`)
  const channels = JSON.parse(chRes.body)

  const results = []
  for (const ch of channels.filter((c) => c.playbackUrl).slice(0, MAX)) {
    const hdr = {
      Referer: ch.referer || '',
      Origin: ch.origin || '',
    }
    if (ch.userAgent) hdr['User-Agent'] = ch.userAgent

    const entry = ch.playbackUrl
    const row = {
      id: ch.id,
      name: ch.name,
      playback_entry: classify(entry),
      stream_delivery_effective: ch.stream_delivery_effective,
      upstream_host: (() => {
        try {
          const q = new URL(entry).searchParams.get('url')
          return q ? new URL(q).hostname : ''
        } catch {
          return ''
        }
      })(),
    }

    try {
      const m = await fetchManifestChain(entry, hdr)
      row.manifest_error = m.error || null
      row.chain = m.chain
      row.url_counts = tally(m.urls || [])
      row.segment_samples = (m.segments || m.urls || []).slice(0, 2)
      row.dominant_segment_route =
        (m.segments || m.urls || []).length > 0
          ? classify((m.segments || m.urls)[0])
          : null
      row.bunny_lines = (m.urls || []).filter((u) => classify(u) === 'bunny_seg').length
      row.proxy_lines = (m.urls || []).filter((u) => classify(u) === 'render_proxy').length
    } catch (e) {
      row.manifest_error = String(e.message || e)
    }
    results.push(row)
    await new Promise((r) => setTimeout(r, 350))
  }

  const bunnyChannels = results.filter((r) => r.bunny_lines > 0)
  const proxyChannels = results.filter((r) => r.proxy_lines > 0)
  const ycn = results.filter((r) => /ycn|lanexa|netvidra|netstack/i.test(r.upstream_host || ''))

  let totalBunny = 0
  let totalProxy = 0
  for (const r of results) {
    totalBunny += r.bunny_lines || 0
    totalProxy += r.proxy_lines || 0
  }
  const denom = totalBunny + totalProxy || 1

  const report = {
    verified_at: new Date().toISOString(),
    commit_expected: 'baefbfd',
    production_config: {
      segments: health.segments,
      playback_force_proxy: health.playback_force_proxy,
      signing_enabled: health.signing_enabled,
      production_segment_offload_active: health.segments?.production_segment_offload_active,
    },
    server_metrics: health.metrics,
    channels_analyzed: results.length,
    channels_with_bunny_seg_in_manifest: bunnyChannels.map((r) => ({ id: r.id, name: r.name, bunny_lines: r.bunny_lines })),
    channels_with_stream_proxy_in_manifest: proxyChannels.map((r) => ({
      id: r.id,
      name: r.name,
      proxy_lines: r.proxy_lines,
      upstream_host: r.upstream_host,
    })),
    ycn_family_channels: ycn.map((r) => ({
      id: r.id,
      name: r.name,
      manifest_error: r.manifest_error,
      dominant_segment_route: r.dominant_segment_route,
      proxy_lines: r.proxy_lines,
      bunny_lines: r.bunny_lines,
      url_counts: r.url_counts,
    })),
    manifest_line_totals: { bunny_seg: totalBunny, render_proxy: totalProxy },
    estimated_bunny_segment_offload_percent: Math.round((totalBunny / denom) * 1000) / 10,
    per_channel: results,
  }

  console.log(JSON.stringify(report, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
