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
import {
  buildUpstreamFetchHeaders,
  isHlsManifestResponse,
  normalizeUpstreamHeaders,
} from '../lib/streamUpstreamHeaders.js'
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

  const upstreamHeaders = normalizeUpstreamHeaders(
    { referer, origin, userAgent: userAgent || DEFAULT_UA },
    parsed.toString(),
  )
  const { headers } = buildUpstreamFetchHeaders(upstreamHeaders, {
    upstreamUrl: parsed.toString(),
    clientAccept: req.headers.accept,
    range: req.headers.range,
    manifest: parsed.pathname.toLowerCase().endsWith('.m3u8'),
  })

  let upstreamRes
  try {
    upstreamRes = await fetch(parsed.href, {
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

  const manifestCandidate =
    String(contentType).toLowerCase().includes('mpegurl') ||
    parsed.pathname.toLowerCase().endsWith('.m3u8')

  if (manifestCandidate) {
    const body = await upstreamRes.text()
    if (!isHlsManifestResponse(finalUrl, contentType, body)) {
      recordBunnyOriginFetch('upstream_error')
      return res.status(502).json({ error: 'upstream response is not a valid HLS manifest' })
    }
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
  let nodeStream
  try {
    nodeStream = Readable.fromWeb(upstreamRes.body)
  } catch (e) {
    console.log(
      '[stream-bunny-origin]',
      JSON.stringify({
        scope: 'stream_body_locked',
        upstream_host: parsed.host,
        error: String(e.message || e),
      }),
    )
    if (!res.headersSent) {
      return res.status(502).json({
        error: 'upstream response body unavailable',
        details: String(e.message || e),
      })
    }
    return
  }
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

function wrapAsyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res)).catch(next)
  }
}

const segmentPath = getBunnySegmentPublicPath()
streamBunnyPullRouter.get(`/${segmentPath}`, wrapAsyncRoute((req, res) => runBunnyOriginSegmentFetch(req, res)))
