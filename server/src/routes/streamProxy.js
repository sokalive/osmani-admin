import { Readable } from 'node:stream'
import { Router } from 'express'
import { recordDirectRequest, recordProxyRequest } from '../lib/streamDeliveryMetrics.js'
import {
  buildPublicStreamProxyUrl,
  PROXY_MOUNT_STREAM,
  rewriteManifest,
} from '../lib/streamManifestRewrite.js'
import { resolveManifestRewriteUrlBuilder } from '../lib/streamSegmentDelivery.js'

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

function extractUpstreamHeaders(req) {
  const referer = String(req.query.referer || req.query.ref || '').trim()
  const origin = String(req.query.origin || '').trim()
  const userAgent = String(req.query.userAgent || req.query.ua || '').trim() || DEFAULT_UA
  return { referer, origin, userAgent }
}

function isManifest(urlStr, contentType) {
  const ct = String(contentType || '').toLowerCase()
  if (ct.includes('application/vnd.apple.mpegurl') || ct.includes('application/x-mpegurl')) return true
  const u = parseMaybeUrl(urlStr)
  return Boolean(u && u.pathname.toLowerCase().endsWith('.m3u8'))
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

  const upstreamHeaders = {
    referer: String(opts?.upstreamHeaders?.referer || '').trim(),
    origin: String(opts?.upstreamHeaders?.origin || '').trim(),
    userAgent: String(opts?.upstreamHeaders?.userAgent || '').trim() || DEFAULT_UA,
  }
  const headers = {
    'User-Agent': upstreamHeaders.userAgent,
    Accept: String(req.headers.accept || '*/*'),
    'Accept-Encoding': 'identity',
  }
  if (upstreamHeaders.referer) headers.Referer = upstreamHeaders.referer
  if (upstreamHeaders.origin) headers.Origin = upstreamHeaders.origin
  if (req.headers.range) headers.Range = String(req.headers.range)

  let upstreamRes
  try {
    upstreamRes = await fetch(parsed.toString(), {
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
    elapsed_ms: Date.now() - startedAt,
  })
  logTokenDiagnostics(finalUrl, status)

  if (!upstreamRes.ok) {
    if (isDirectEntry) recordDirectRequest('upstream_error')
    else recordProxyRequest('upstream_error')
    const bodyText = await upstreamRes.text().catch(() => '')
    return res.status(upstreamRes.status).send(bodyText || `Upstream error (${upstreamRes.status})`)
  }

  if (isManifest(finalUrl, contentType)) {
    const body = await upstreamRes.text()
    const rewriteCtx =
      opts?.manifestRewriteUrlBuilder ||
      resolveManifestRewriteUrlBuilder(req, { channelId: opts?.channelId })
    const { text: rewrittenCore, rewriteCount } = rewriteManifest(
      body,
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
      output_bytes: Buffer.byteLength(text, 'utf8'),
      has_extm3u: text.includes('#EXTM3U'),
    })
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Stream-Segment-Delivery', rewriteCtx.segmentDelivery)
    if (isDirectEntry) recordDirectRequest('manifest_ok')
    else recordProxyRequest('manifest_ok')
    return res.status(200).send(text)
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
  const nodeStream = Readable.fromWeb(upstreamRes.body)
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

async function runStreamProxy(req, res, mountPath) {
  const sourceUrl = String(req.query.url || '').trim()
  const upstreamHeaders = extractUpstreamHeaders(req)
  return runStreamProxyRequest(req, res, { sourceUrl, upstreamHeaders, mountPath })
}

streamProxyRouter.get(`/${PROXY_MOUNT_STREAM}`, (req, res) => runStreamProxy(req, res, PROXY_MOUNT_STREAM))
streamProxyRouter.get(`/${PROXY_MOUNT_TEST}`, (req, res) => runStreamProxy(req, res, PROXY_MOUNT_TEST))
