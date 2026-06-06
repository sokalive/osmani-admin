/**
 * HLS manifest rewrite — segment lines rewritten via injectable URL builder (proxy or Bunny CDN).
 */
import { resolveStreamApiBaseUrl } from './directStreamSigning.js'

export const PROXY_MOUNT_STREAM = 'stream-proxy'

const SEGMENT_EXT_RE = /\.(ts|m4s|aac|mp4|m3u8)(\?.*)?$/i

function parseMaybeUrl(raw) {
  try {
    return new URL(String(raw || ''))
  } catch {
    return null
  }
}

export function resolveBaseOrigin(req) {
  return resolveStreamApiBaseUrl(req)
}

export function buildProxyUrl(req, absoluteTarget, hdr, mountPath) {
  const base = resolveBaseOrigin(req)
  const path = String(mountPath || PROXY_MOUNT_STREAM).replace(/^\/+/, '').replace(/\/+$/, '')
  const q = new URLSearchParams()
  q.set('url', absoluteTarget)
  if (hdr.referer) q.set('referer', hdr.referer)
  if (hdr.origin) q.set('origin', hdr.origin)
  if (hdr.userAgent) q.set('userAgent', hdr.userAgent)
  return `${base}/${path}?${q.toString()}`
}

function toAbsoluteResourceUri(rawUri, baseUrl) {
  const s = String(rawUri || '').trim()
  if (!s) return s
  if (s.startsWith('data:')) return s
  try {
    return new URL(s, baseUrl).toString()
  } catch {
    return s
  }
}

function rewriteAttributeUri(line, baseUrl, upstreamHeaders, counter, buildTargetUrl) {
  return line.replace(/URI="([^"]+)"/gi, (_m, uri) => {
    const absolute = toAbsoluteResourceUri(uri, baseUrl)
    if (!absolute || absolute.startsWith('data:')) return `URI="${uri}"`
    counter.count += 1
    const rewritten = buildTargetUrl(absolute, upstreamHeaders)
    return `URI="${rewritten}"`
  })
}

/**
 * @param {string} manifest
 * @param {string} baseUrl — final upstream manifest URL
 * @param {{ referer?: string, origin?: string, userAgent?: string }} upstreamHeaders
 * @param {(absoluteUrl: string, hdr: object) => string} buildTargetUrl
 */
export function rewriteManifest(manifest, baseUrl, upstreamHeaders, buildTargetUrl) {
  const lines = String(manifest || '').split(/\r?\n/)
  const counter = { count: 0 }
  const hdr = upstreamHeaders || {}
  const rewritten = lines.map((line) => {
    const trimmed = line.trim()
    if (!trimmed) return line
    if (trimmed.startsWith('#EXT-X-KEY') || trimmed.startsWith('#EXT-X-MAP')) {
      return rewriteAttributeUri(line, baseUrl, hdr, counter, buildTargetUrl)
    }
    if (trimmed.startsWith('#')) return line
    if (!SEGMENT_EXT_RE.test(trimmed) && !trimmed.includes('/')) {
      return line
    }
    const absolute = toAbsoluteResourceUri(trimmed, baseUrl)
    counter.count += 1
    return buildTargetUrl(absolute, hdr)
  })
  return { text: rewritten.join('\n'), rewriteCount: counter.count }
}

export function buildPublicStreamProxyUrl(req, absoluteTarget, hdr = {}) {
  const sourceUrl = String(absoluteTarget || '').trim()
  if (!sourceUrl) return ''
  const parsed = parseMaybeUrl(sourceUrl)
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) return ''
  return buildProxyUrl(
    req,
    parsed.toString(),
    {
      referer: String(hdr.referer || '').trim(),
      origin: String(hdr.origin || '').trim(),
      userAgent: String(hdr.userAgent || '').trim(),
    },
    PROXY_MOUNT_STREAM,
  )
}
