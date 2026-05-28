/**
 * Normalize referer / origin / user-agent for upstream HLS fetches (ycn-redirect, Exo, etc.).
 *
 * ycn / Cloudflare parity note (audited 2026-05-28):
 * - Desktop Chrome UA + Referer → 200 #EXTM3U from server/datacenter IPs
 * - Android Mobile / ExoPlayerLib UA → 403 Cloudflare HTML block
 * Exo on device talks to our proxy; upstream fetch should mimic desktop browser, not Exo UA.
 */
import { extractUrlHost, isProtectedSegmentTarget } from './streamProtectedProviders.js'

/** Upstream fetch UA for ycn/protected providers (NOT the Exo client UA). */
const YCN_UPSTREAM_UA =
  process.env.STREAM_YCN_UPSTREAM_USER_AGENT ||
  process.env.STREAM_YCN_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const DEFAULT_PROXY_UA =
  process.env.STREAM_PROXY_USER_AGENT ||
  'Mozilla/5.0 (Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36'

function isHttpOrigin(value) {
  const s = String(value || '').trim()
  if (!s.startsWith('http://') && !s.startsWith('https://')) return false
  try {
    const u = new URL(s)
    return Boolean(u.hostname)
  } catch {
    return false
  }
}

function originFromUrl(urlStr) {
  try {
    const u = new URL(String(urlStr || ''))
    return `${u.protocol}//${u.host}`
  } catch {
    return ''
  }
}

function inferYcnReferer(upstreamUrl, referer) {
  if (isHttpOrigin(referer)) return String(referer).trim()
  const host = extractUrlHost(upstreamUrl)
  if (host) {
    try {
      const u = new URL(upstreamUrl)
      return `${u.protocol}//${host}/`
    } catch {
      /* ignore */
    }
  }
  return 'https://het140c.ycn-redirect.com/'
}

function isMimeTypeOrigin(value) {
  const s = String(value || '').trim().toLowerCase()
  return s.includes('mpegurl') || s.includes('octet-stream') || s === '*/*'
}

function isBlockedMobileOrExoUa(ua) {
  const s = String(ua || '')
  return (
    /ExoPlayerLib/i.test(s) ||
    /Android.*Mobile Safari/i.test(s) ||
    (/Android/i.test(s) && /Mobile/i.test(s) && !/Windows NT/i.test(s))
  )
}

/**
 * UA sent to ycn upstream. Desktop browser fingerprint; Exo only hits our API.
 */
export function pickYcnUpstreamUserAgent(channelUa) {
  const custom = String(
    process.env.STREAM_YCN_UPSTREAM_USER_AGENT || process.env.STREAM_YCN_USER_AGENT || '',
  ).trim()
  if (custom) return custom
  const ua = String(channelUa || '').trim()
  if (ua && /Windows NT/i.test(ua) && !/ExoPlayerLib/i.test(ua)) {
    return ua
  }
  return YCN_UPSTREAM_UA
}

/**
 * @param {{ referer?: string, origin?: string, userAgent?: string }} hdr
 * @param {string} [upstreamUrl]
 */
export function normalizeUpstreamHeaders(hdr = {}, upstreamUrl = '') {
  const upstream = String(upstreamUrl || '').trim()
  let referer = String(hdr.referer || '').trim()
  let origin = String(hdr.origin || '').trim()
  let userAgent = String(hdr.userAgent || '').trim() || DEFAULT_PROXY_UA

  const protectedUpstream = upstream
    ? isProtectedSegmentTarget(upstream, { referer, origin, userAgent }, { rootUpstreamUrl: upstream })
    : false

  if (protectedUpstream) {
    referer = inferYcnReferer(upstream, referer)
    userAgent = pickYcnUpstreamUserAgent(userAgent)
  }

  if (!isHttpOrigin(origin) || isMimeTypeOrigin(origin)) {
    origin = originFromUrl(referer) || originFromUrl(upstream) || ''
  }

  return { referer, origin, userAgent, protectedUpstream }
}

/**
 * Headers for node fetch() to upstream CDN/provider.
 * @param {{ referer?: string, origin?: string, userAgent?: string }} hdr
 * @param {{ clientAccept?: string, range?: string, manifest?: boolean, upstreamUrl?: string }} [opts]
 */
export function buildUpstreamFetchHeaders(hdr, opts = {}) {
  const normalized = normalizeUpstreamHeaders(hdr, opts.upstreamUrl || '')
  const headers = {
    'User-Agent': normalized.userAgent,
    Accept: normalized.protectedUpstream
      ? '*/*'
      : opts.manifest
        ? 'application/vnd.apple.mpegurl,application/x-mpegurl,*/*'
        : String(opts.clientAccept || '*/*'),
    'Accept-Encoding': 'identity',
  }
  if (!normalized.protectedUpstream) {
    headers['Accept-Language'] = 'en-US,en;q=0.9'
  }
  if (normalized.referer) headers.Referer = normalized.referer
  if (normalized.origin && isHttpOrigin(normalized.origin)) {
    headers.Origin = normalized.origin
  }
  if (opts.range) headers.Range = String(opts.range)
  return { headers, normalized }
}

/**
 * Detect real HLS manifests (avoid treating HTML error pages as m3u8 when URL ends in .m3u8).
 */
export function isHlsManifestResponse(finalUrl, contentType, bodyText) {
  const ct = String(contentType || '').toLowerCase()
  if (ct.includes('text/html')) return false
  const body = String(bodyText || '').trimStart()
  if (body.startsWith('#EXTM3U')) return true
  if (body.startsWith('<') || body.startsWith('{')) return false
  try {
    const u = new URL(String(finalUrl || ''))
    if (u.pathname.toLowerCase().endsWith('.m3u8') && body.startsWith('#')) {
      return body.includes('#EXT')
    }
  } catch {
    /* ignore */
  }
  if (ct.includes('application/vnd.apple.mpegurl') || ct.includes('application/x-mpegurl')) {
    return body.startsWith('#') && body.includes('#EXT')
  }
  return false
}

export function getYcnUpstreamHeaderProfile() {
  return {
    upstream_user_agent: YCN_UPSTREAM_UA,
    note: 'Exo on phone uses proxy URLs; ycn sees desktop Chrome from server egress',
  }
}
