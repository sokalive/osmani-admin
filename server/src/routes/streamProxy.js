import { Readable } from 'node:stream'
import { Router } from 'express'
import { recordDirectRequest, recordProxyRequest } from '../lib/streamDeliveryMetrics.js'
import {
  buildPublicStreamProxyUrl,
  PROXY_MOUNT_STREAM,
  rewriteManifest,
} from '../lib/streamManifestRewrite.js'
import { resolveManifestRewriteUrlBuilder } from '../lib/streamSegmentDelivery.js'
import {
  buildUpstreamFetchHeaders,
  isHlsManifestResponse,
  normalizeUpstreamHeaders,
} from '../lib/streamUpstreamHeaders.js'
import { injectMpingoHtmlBaseHref, isMpingoPlayerPageUrl } from '../lib/streamMpingoHtmlBase.js'

export { PROXY_MOUNT_STREAM, buildPublicStreamProxyUrl } from '../lib/streamManifestRewrite.js'

export const streamProxyRouter = Router()

const PROXY_MOUNT_TEST = 'stream-proxy-test'

const DEFAULT_UA =
  process.env.STREAM_PROXY_USER_AGENT ||
  'Mozilla/5.0 (Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36'

const MAX_URL_LENGTH = 4000

function parseMaybeUrl(raw) {
  try {
    return new URL(String(raw || ''))
  } catch {
    return null
  }
}

function extractUpstreamHeaders(req, sourceUrl) {
  const raw = {
    referer: String(req.query.referer || req.query.ref || '').trim(),
    origin: String(req.query.origin || '').trim(),
    userAgent: String(req.query.userAgent || req.query.ua || '').trim() || DEFAULT_UA,
  }
  return normalizeUpstreamHeaders(raw, sourceUrl)
}

function logProxyDiagnostics(payload) {
  console.log('[stream-proxy]', JSON.stringify(payload))
}

function logTokenDiagnostics(urlStr, status) {
  if (![401, 403].includes(Number(status))) return
  const u = parseMaybeUrl(urlStr)
  if (!u) return
  const candidates = ['e', 'exp', 'expires', 'token_exp']
  let expiry = null
  for (const k of candidates) {
    const v = String(u.searchParams.get(k) || '').trim()
    if (!v) continue
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) {
      expiry = n < 10_000_000_000 ? n * 1000 : n
      break
    }
  }
  logProxyDiagnostics({
    scope: 'token_diagnostics',
    status,
    upstream_host: u.host,
    expiry_iso: expiry ? new Date(expiry).toISOString() : null,
    expired: expiry ? Date.now() > expiry : null,
    query_keys: [...u.searchParams.keys()],
  })
}

function appendManifestSessionHint(text, sessionId, segmentDelivery, tokenExpSec) {
  if (!sessionId) return text
  const lines = [text]
  lines.push(`#EXT-X-OSMANI-SESSION:${sessionId}`)
  lines.push(`#EXT-X-OSMANI-SEG-DELIVERY:${segmentDelivery}`)
  if (tokenExpSec) {
    lines.push(`#EXT-X-OSMANI-SEG-EXP:${tokenExpSec}`)
  }
  return lines.join('\n')
}

/**
 * Shared proxy runner for /stream-proxy and token-gated /stream-direct.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{ sourceUrl: string, upstreamHeaders: { referer?: string, origin?: string, userAgent?: string }, mountPath: string, channelId?: string, manifestRewriteUrlBuilder?: ReturnType<typeof resolveManifestRewriteUrlBuilder> }} opts
 */
function respondUpstreamNotManifest(res, mountPath, parsed, finalUrl, status, contentType, bodyPreview, upstreamHeaders) {
  logProxyDiagnostics({
    scope: 'upstream_not_manifest',
    mount: mountPath,
    source_url: parsed.toString(),
    final_url: finalUrl,
    status,
    content_type: contentType,
    body_preview: bodyPreview,
    upstream_headers: upstreamHeaders,
  })
  return res.status(502).json({
    error: 'upstream response is not a valid HLS manifest',
    status,
    content_type: contentType,
  })
}

export async function runStreamProxyRequest(req, res, opts) {
  const startedAt = Date.now()
  const mountPath = String(opts?.mountPath || PROXY_MOUNT_STREAM)
  const isDirectEntry = mountPath === 'stream-direct'
  const sourceUrl = String(opts?.sourceUrl || '').trim()
  if (!sourceUrl) {
    return res.status(400).json({ error: 'url query param is required' })
  }
  if (sourceUrl.length > MAX_URL_LENGTH) {
    return res.status(400).json({ error: 'url too long' })
  }
  const parsed = parseMaybeUrl(sourceUrl)
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: 'url must be absolute http(s)' })
  }

  try {
    return await runStreamProxyRequestInner(req, res, opts, {
      startedAt,
      mountPath,
      isDirectEntry,
      sourceUrl,
      parsed,
    })
  } catch (e) {
    const errMsg = String(e?.message || e)
    const stack = String(e?.stack || '').split('\n').slice(0, 8).join('\n')
    if (isDirectEntry) recordDirectRequest('runtime_error')
    else recordProxyRequest('runtime_error')
    logProxyDiagnostics({
      scope: 'runtime_error',
      mount: mountPath,
      source_url: parsed.toString(),
      error: errMsg,
      stack,
      elapsed_ms: Date.now() - startedAt,
    })
    if (!res.headersSent) {
      return res.status(502).json({
        error: 'stream proxy runtime error',
        details: errMsg,
      })
    }
    res.destroy(e)
  }
}

async function runStreamProxyRequestInner(req, res, opts, ctx) {
  const { startedAt, mountPath, isDirectEntry, parsed } = ctx
  const sourceUrl = ctx.sourceUrl

  const upstreamHeaders = normalizeUpstreamHeaders(
    {
      referer: opts?.upstreamHeaders?.referer,
      origin: opts?.upstreamHeaders?.origin,
      userAgent: opts?.upstreamHeaders?.userAgent || DEFAULT_UA,
    },
    parsed.toString(),
  )
  const { headers } = buildUpstreamFetchHeaders(upstreamHeaders, {
    upstreamUrl: parsed.toString(),
    clientAccept: req.headers.accept,
    range: req.headers.range,
    manifest: true,
  })

  let upstreamRes
  try {
    upstreamRes = await fetch(parsed.href, {
      method: 'GET',
      redirect: 'follow',
      headers,
    })
  } catch (e) {
    if (isDirectEntry) recordDirectRequest('fetch_error')
    else recordProxyRequest('upstream_error')
    logProxyDiagnostics({
      scope: 'fetch_error',
      mount: mountPath,
      source_url: parsed.toString(),
      error: String(e.message || e),
      elapsed_ms: Date.now() - startedAt,
    })
    return res.status(502).json({ error: 'upstream fetch failed', details: String(e.message || e) })
  }

  const finalUrl = String(upstreamRes.url || parsed.toString())
  const status = Number(upstreamRes.status)
  const contentType = upstreamRes.headers.get('content-type') || 'application/octet-stream'
  logProxyDiagnostics({
      scope: 'request',
      mount: mountPath,
      source_url: parsed.toString(),
      final_url: finalUrl,
      status,
      upstream_headers: upstreamHeaders,
      upstream_fetch_headers: headers,
      elapsed_ms: Date.now() - startedAt,
    })
  logTokenDiagnostics(finalUrl, status)

  if (!upstreamRes.ok) {
    const errBody = await upstreamRes.text().catch(() => '')
    if (isDirectEntry) recordDirectRequest('upstream_error')
    else recordProxyRequest('upstream_error')
    logProxyDiagnostics({
      scope: 'upstream_error',
      mount: mountPath,
      source_url: parsed.toString(),
      final_url: finalUrl,
      status,
      upstream_headers: upstreamHeaders,
      body_preview: errBody.slice(0, 120),
    })
    return res.status(upstreamRes.status).send(errBody || `Upstream error (${upstreamRes.status})`)
  }

  const manifestCandidate =
    String(contentType).toLowerCase().includes('mpegurl') ||
    parsed.pathname.toLowerCase().endsWith('.m3u8')

  if (manifestCandidate) {
    const bodyText = await upstreamRes.text().catch(() => '')
    if (isHlsManifestResponse(finalUrl, contentType, bodyText)) {
      try {
        const rewriteCtx =
          opts?.manifestRewriteUrlBuilder ||
          resolveManifestRewriteUrlBuilder(req, {
            channelId: opts?.channelId,
            channelHeaders: upstreamHeaders,
            rootUpstreamUrl: opts?.rootUpstreamUrl || parsed.toString(),
          })
        const { text: rewrittenCore, rewriteCount } = rewriteManifest(
          bodyText,
          finalUrl,
          upstreamHeaders,
          (absolute, hdr) => rewriteCtx.buildTargetUrl(absolute, hdr),
        )
        const text = appendManifestSessionHint(
          rewrittenCore,
          rewriteCtx.sessionId,
          rewriteCtx.segmentDelivery,
          null,
        )
        logProxyDiagnostics({
          scope: 'manifest_rewrite',
          mount: mountPath,
          source_url: parsed.toString(),
          final_url: finalUrl,
          rewritten_url_count: rewriteCount,
          segment_delivery: rewriteCtx.segmentDelivery,
          segment_route_stats: rewriteCtx.getRouteStats?.() || null,
          upstream_headers_normalized: upstreamHeaders,
          output_bytes: Buffer.byteLength(text, 'utf8'),
          has_extm3u: text.includes('#EXTM3U'),
        })
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('X-Stream-Segment-Delivery', rewriteCtx.segmentDelivery)
        if (isDirectEntry) recordDirectRequest('manifest_ok')
        else recordProxyRequest('manifest_ok')
        return res.status(200).send(text)
      } catch (e) {
        logProxyDiagnostics({
          scope: 'manifest_rewrite_error',
          mount: mountPath,
          source_url: parsed.toString(),
          error: String(e.message || e),
        })
        return res.status(502).json({ error: 'manifest rewrite failed', details: String(e.message || e) })
      }
    }

    return respondUpstreamNotManifest(
      res,
      mountPath,
      parsed,
      finalUrl,
      status,
      contentType,
      bodyText.slice(0, 120),
      upstreamHeaders,
    )
  }

  const mpingoPlayerHtml =
    /text\/html/i.test(contentType) && isMpingoPlayerPageUrl(finalUrl || parsed.href)
  if (mpingoPlayerHtml) {
    const bodyText = await upstreamRes.text().catch(() => '')
    const outbound = injectMpingoHtmlBaseHref(bodyText, finalUrl || parsed.href)
    logProxyDiagnostics({
      scope: 'mpingo_html_base',
      mount: mountPath,
      source_url: parsed.toString(),
      final_url: finalUrl,
      base_href: new URL('./', finalUrl || parsed.href).href,
      output_bytes: Buffer.byteLength(outbound, 'utf8'),
    })
    if (isDirectEntry) recordDirectRequest('segment_passthrough')
    else recordProxyRequest('segment_passthrough')
    res.status(upstreamRes.status)
    res.setHeader('Content-Type', contentType.includes('charset') ? contentType : 'text/html; charset=UTF-8')
    res.setHeader('Cache-Control', 'no-store')
    return res.send(outbound)
  }

  if (isDirectEntry) recordDirectRequest('segment_passthrough')
  else recordProxyRequest('segment_passthrough')
  res.status(upstreamRes.status)
  const passthroughHeaders = [
    'content-type',
    'content-length',
    'accept-ranges',
    'content-range',
    'etag',
    'last-modified',
    'cache-control',
    'expires',
  ]
  for (const name of passthroughHeaders) {
    const value = upstreamRes.headers.get(name)
    if (value) res.setHeader(name, value)
  }

  if (!upstreamRes.body) return res.end()
  let nodeStream
  try {
    nodeStream = Readable.fromWeb(upstreamRes.body)
  } catch (e) {
    logProxyDiagnostics({
      scope: 'stream_body_locked',
      mount: mountPath,
      source_url: parsed.toString(),
      final_url: finalUrl,
      error: String(e.message || e),
    })
    if (!res.headersSent) {
      return res.status(502).json({
        error: 'upstream response body unavailable',
        details: String(e.message || e),
      })
    }
    return
  }
  nodeStream.on('error', (e) => {
    logProxyDiagnostics({
      scope: 'stream_error',
      mount: mountPath,
      source_url: parsed.toString(),
      final_url: finalUrl,
      error: String(e.message || e),
    })
    res.destroy(e)
  })
  return nodeStream.pipe(res)
}

function wrapAsyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res)).catch(next)
  }
}

async function runStreamProxy(req, res, mountPath) {
  const sourceUrl = String(req.query.url || '').trim()
  const upstreamHeaders = extractUpstreamHeaders(req, sourceUrl)
  return runStreamProxyRequest(req, res, { sourceUrl, upstreamHeaders, mountPath })
}

streamProxyRouter.get(`/${PROXY_MOUNT_STREAM}`, wrapAsyncRoute((req, res) => runStreamProxy(req, res, PROXY_MOUNT_STREAM)))
streamProxyRouter.get(`/${PROXY_MOUNT_TEST}`, wrapAsyncRoute((req, res) => runStreamProxy(req, res, PROXY_MOUNT_TEST)))
