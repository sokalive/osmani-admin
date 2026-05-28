/**
 * Detect HLS providers that require per-request referer / UA / token handling.
 * These targets use Render stream-proxy for segments; others use Bunny CDN by default.
 */

const BUILTIN_PROTECTED_HOST_SUFFIXES = [
  'ycn-redirect.com',
  'lanexa.online',
  'netvidra.online',
  'netstack.online',
  'loadcore.online',
]

/** Host suffixes always treated as public CDN (force Bunny when enabled). */
const BUILTIN_PUBLIC_HOST_SUFFIXES = ['akamaized.net', 'cloudfront.net', 'fastly.net']

function parseHostList(raw) {
  return String(raw || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
}

function hostSuffixes() {
  const extra = parseHostList(process.env.STREAM_SEGMENT_PROTECTED_HOSTS)
  return [...new Set([...BUILTIN_PROTECTED_HOST_SUFFIXES, ...extra])]
}

function publicHostSuffixes() {
  return parseHostList(process.env.STREAM_SEGMENT_PUBLIC_HOSTS).concat(BUILTIN_PUBLIC_HOST_SUFFIXES)
}

export function extractUrlHost(rawUrl) {
  try {
    return new URL(String(rawUrl || '')).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function hostMatchesSuffix(host, suffix) {
  const h = String(host || '').toLowerCase()
  const s = String(suffix || '').toLowerCase()
  if (!h || !s) return false
  return h === s || h.endsWith(`.${s}`)
}

function hostMatchesAnySuffix(host, suffixes) {
  return suffixes.some((s) => hostMatchesSuffix(host, s))
}

function urlHasAuthQuery(urlStr) {
  try {
    const u = new URL(String(urlStr || ''))
    const q = u.searchParams
    if (q.has('t') && (q.has('e') || q.has('exp') || q.has('expires'))) return true
    if (q.has('token') && (q.has('e') || q.has('exp') || q.has('expires'))) return true
    if (q.has('st') && q.has('e')) return true
  } catch {
    /* ignore */
  }
  return false
}

function pathLooksTokenized(urlStr) {
  const p = String(urlStr || '').toLowerCase()
  return (
    /\.m3u8(\?|$)/i.test(p) ||
    /\.(ts|m4s|aac)(\?|$)/i.test(p) ||
    /\/\d+\.js(\?|$)/i.test(p) ||
    /\/live\//i.test(p)
  )
}

/**
 * @param {string} absoluteUrl
 * @param {{ referer?: string, origin?: string, userAgent?: string }} [hdr]
 * @param {{ rootUpstreamUrl?: string, channelReferer?: string }} [ctx]
 */
export function isProtectedSegmentTarget(absoluteUrl, hdr = {}, ctx = {}) {
  const host = extractUrlHost(absoluteUrl)
  if (!host) return false

  if (hostMatchesAnySuffix(host, publicHostSuffixes())) return false

  if (hostMatchesAnySuffix(host, hostSuffixes())) return true

  const rootHost = extractUrlHost(ctx.rootUpstreamUrl)
  if (rootHost && hostMatchesAnySuffix(rootHost, hostSuffixes())) {
    if (hostMatchesSuffix(host, rootHost) || hostMatchesAnySuffix(host, hostSuffixes())) {
      return true
    }
  }

  if (urlHasAuthQuery(absoluteUrl)) return true
  if (urlHasAuthQuery(ctx.rootUpstreamUrl)) {
    if (hostMatchesAnySuffix(host, hostSuffixes()) || host === rootHost) {
      return pathLooksTokenized(absoluteUrl)
    }
    if (
      pathLooksTokenized(absoluteUrl) &&
      hostMatchesAnySuffix(rootHost, hostSuffixes()) &&
      host.endsWith('.online') &&
      !hostMatchesAnySuffix(host, publicHostSuffixes())
    ) {
      return true
    }
  }

  const channelReferer = String(ctx.channelReferer || hdr.referer || '').trim()
  if (channelReferer && urlHasAuthQuery(absoluteUrl)) return true

  if (channelReferer && hostMatchesAnySuffix(extractUrlHost(channelReferer), hostSuffixes())) {
    if (
      pathLooksTokenized(absoluteUrl) &&
      (hostMatchesAnySuffix(host, hostSuffixes()) ||
        (host.endsWith('.online') && !hostMatchesAnySuffix(host, publicHostSuffixes())))
    ) {
      return true
    }
  }

  return false
}

export function isSelectiveSegmentRoutingEnabled() {
  const raw = process.env.STREAM_SEGMENT_SELECTIVE_ROUTING
  if (raw === undefined || raw === null || String(raw).trim() === '') return true
  return !['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase())
}

export function getProtectedProviderConfig() {
  return {
    selective_routing_enabled: isSelectiveSegmentRoutingEnabled(),
    protected_host_suffixes: hostSuffixes(),
    public_host_suffixes: publicHostSuffixes(),
    builtin_protected: BUILTIN_PROTECTED_HOST_SUFFIXES,
  }
}
