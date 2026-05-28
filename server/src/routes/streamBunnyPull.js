import { Readable } from 'node:stream'
import { Router } from 'express'
import { verifyStreamSegmentToken } from '../lib/directStreamSigning.js'
import { rewriteManifest } from '../lib/streamManifestRewrite.js'
import {
  getBunnyOriginCacheMaxAgeSec,
  getBunnySegmentPublicPath,
  resolveManifestRewriteUrlBuilder,
  verifyBunnyOriginRequest,
} from '../lib/streamSegmentDelivery.js'
import { recordBunnyOriginFetch } from '../lib/streamDeliveryMetrics.js'

export const streamBunnyPullRouter = Router()

const DEFAULT_UA =
  process.env.STREAM_PROXY_USER_AGENT ||
  'Mozilla/5.0 (Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36'

function parseMaybeUrl(raw) {
  try {
    return new URL(String(raw || ''))
  } catch {
    return null
  }
}

function isManifest(urlStr, contentType) {
  const ct = String(contentType || '').toLowerCase()
  if (ct.includes('application/vnd.apple.mpegurl') || ct.includes('application/x-mpegurl')) return true
  const u = parseMaybeUrl(urlStr)
  return Boolean(u && u.pathname.toLowerCase().endsWith('.m3u8'))
}

/**
 * Bunny pull-zone origin: validates segment token, fetches upstream, returns cacheable body.
 * End-users should only request the Bunny CDN URL; this route serves Bunny origin-pull on miss.
 */
export async function runBunnyOriginSegmentFetch(req, res) {
  const startedAt = Date.now()
  const originAuth = verifyBunnyOriginRequest(req)
  if (!originAuth.ok) {
    recordBunnyOriginFetch('origin_auth_denied')
    return res.status(originAuth.status).json({ error: originAuth.error })
  }

  const verified = verifyStreamSegmentToken(req.query.tok || req.query.token)
  if (!verified.ok) {
    recordBunnyOriginFetch('token_invalid')
    return res.status(verified.status).json({ error: verified.error })
  }

  const { upstreamUrl, referer, origin, userAgent, channelId, sessionId } = verified.payload
  const parsed = parseMaybeUrl(upstreamUrl)
  if (!parsed) {
    recordBunnyOriginFetch('token_invalid')
    return res.status(400).json({ error: 'Invalid upstream URL' })
  }

  const headers = {
    'User-Agent': userAgent || DEFAULT_UA,
    Accept: String(req.headers.accept || '*/*'),
    'Accept-Encoding': 'identity',
  }
  if (referer) headers.Referer = referer
  if (origin) headers.Origin = origin
  if (req.headers.range) headers.Range = String(req.headers.range)

  let upstreamRes
  try {
    upstreamRes = await fetch(parsed.toString(), {
      method: 'GET',
      redirect: 'follow',
      headers,
    })
  } catch (e) {
    recordBunnyOriginFetch('fetch_error')
    console.log(
      '[stream-bunny-origin]',
      JSON.stringify({
        scope: 'fetch_error',
        upstream_host: parsed.host,
        channel_id: channelId,
        session_id: sessionId,
        error: String(e.message || e),
        elapsed_ms: Date.now() - startedAt,
      }),
    )
    return res.status(502).json({ error: 'upstream fetch failed', details: String(e.message || e) })
  }

  const status = Number(upstreamRes.status)
  const contentType = upstreamRes.headers.get('content-type') || 'application/octet-stream'

  if (!upstreamRes.ok) {
    recordBunnyOriginFetch('upstream_error')
    const bodyText = await upstreamRes.text().catch(() => '')
    return res.status(upstreamRes.status).send(bodyText || `Upstream error (${upstreamRes.status})`)
  }

  const finalUrl = String(upstreamRes.url || parsed.toString())

  if (isManifest(finalUrl, contentType)) {
    const body = await upstreamRes.text()
    const upstreamHeaders = { referer, origin, userAgent }
    const rewriteCtx = resolveManifestRewriteUrlBuilder(req, {
      channelId,
      sessionId,
      channelHeaders: upstreamHeaders,
      rootUpstreamUrl: upstreamUrl,
    })
    const { text, rewriteCount } = rewriteManifest(body, finalUrl, upstreamHeaders, (absolute, hdr) =>
      rewriteCtx.buildTargetUrl(absolute, hdr),
    )
    recordBunnyOriginFetch('ok')
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Stream-Segment-Delivery', rewriteCtx.segmentDelivery)
    console.log(
      '[stream-bunny-origin]',
      JSON.stringify({
        scope: 'manifest_rewrite',
        upstream_host: parsed.host,
        rewritten_url_count: rewriteCount,
        channel_id: channelId,
        session_id: sessionId,
        elapsed_ms: Date.now() - startedAt,
      }),
    )
    return res.status(200).send(text)
  }

  recordBunnyOriginFetch('ok')
  const maxAge = getBunnyOriginCacheMaxAgeSec()
  res.setHeader('X-Stream-Segment-Origin', 'bunny-pull')
  res.setHeader('X-Stream-Channel-Id', channelId || '')
  res.setHeader('Cache-Control', `public, max-age=${maxAge}, s-maxage=${maxAge}`)
  res.setHeader('CDN-Cache-Control', `public, max-age=${maxAge}`)
  res.status(status)

  const passthroughHeaders = [
    'content-type',
    'content-length',
    'accept-ranges',
    'content-range',
    'etag',
    'last-modified',
  ]
  for (const name of passthroughHeaders) {
    const value = upstreamRes.headers.get(name)
    if (value) res.setHeader(name, value)
  }
  if (!res.getHeader('content-type')) {
    res.setHeader('content-type', contentType)
  }

  console.log(
    '[stream-bunny-origin]',
    JSON.stringify({
      scope: 'segment_ok',
      upstream_host: parsed.host,
      status,
      channel_id: channelId,
      session_id: sessionId,
      cache_max_age_sec: maxAge,
      elapsed_ms: Date.now() - startedAt,
    }),
  )

  if (!upstreamRes.body) return res.end()
  const nodeStream = Readable.fromWeb(upstreamRes.body)
  nodeStream.on('error', (e) => {
    console.log(
      '[stream-bunny-origin]',
      JSON.stringify({
        scope: 'stream_error',
        upstream_host: parsed.host,
        error: String(e.message || e),
      }),
    )
    res.destroy(e)
  })
  return nodeStream.pipe(res)
}

const segmentPath = getBunnySegmentPublicPath()
streamBunnyPullRouter.get(`/${segmentPath}`, (req, res) => runBunnyOriginSegmentFetch(req, res))
