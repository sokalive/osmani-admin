/**
 * Stream-proxy host allowlist + SSRF guards.
 * Not an open internet proxy: only catalog/env/builtin/protected roots
 * and media segments under an already-authorized root.
 */
import dns from 'node:dns/promises'
import net from 'node:net'
import {
  extractUrlHost,
  getProtectedProviderConfig,
  isProtectedSegmentTarget,
} from './streamProtectedProviders.js'

const BUILTIN_CLEARTEXT_BRIDGE_HOSTS = [
  'bein.mpilalivetv.com',
  'mpilalivetv.com',
]

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata',
  '0.0.0.0',
])

/** @type {Set<string>} */
let catalogHttpHosts = new Set()
/** Rotating-edge suffixes derived from eligible catalog HTTP hosts (label-boundary safe). */
/** @type {Set<string>} */
let catalogProviderSuffixes = new Set()
let catalogSyncedAt = 0

function parseHostList(raw) {
  return String(raw || '')
    .split(/[,\s]+/)
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
}

export function getEnvCleartextHttpBridgeHosts() {
  return parseHostList(process.env.STREAM_CLEARTEXT_HTTP_BRIDGE_HOSTS)
}

/**
 * DNS-label boundary suffix match.
 * ALLOW: h42.kavorexacloud.click vs kavorexacloud.click
 * DENY: kavorexacloud.click.evil.com, notkavorexacloud.click
 */
export function hostMatchesDnsLabelSuffix(host, suffix) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '')
  const s = String(suffix || '').toLowerCase().replace(/\.$/, '')
  if (!h || !s) return false
  if (h === s) return true
  return h.endsWith(`.${s}`) && h.length > s.length + 1
}

function hostMatchesSuffix(host, suffix) {
  return hostMatchesDnsLabelSuffix(host, suffix)
}

function hostMatchesAny(host, list) {
  return list.some((s) => hostMatchesSuffix(host, s))
}

export function isPrivateOrLocalIp(ip) {
  const s = String(ip || '').trim().toLowerCase()
  if (!s) return true
  if (s === '::1' || s === '0:0:0:0:0:0:0:1') return true
  if (s.startsWith('fe80:') || s.startsWith('fc') || s.startsWith('fd')) return true
  if (s === '::' || s === '0.0.0.0') return true

  if (net.isIPv4(s)) {
    const parts = s.split('.').map((n) => Number(n))
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return true
    const [a, b] = parts
    if (a === 10) return true
    if (a === 127) return true
    if (a === 0) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return true
  }
  return false
}

export function isBlockedHostname(hostname) {
  const h = String(hostname || '').trim().toLowerCase().replace(/\.$/, '')
  if (!h) return true
  if (BLOCKED_HOSTNAMES.has(h)) return true
  if (h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  if (net.isIP(h)) return isPrivateOrLocalIp(h)
  return false
}

export function isHlsMediaPath(pathnameOrUrl) {
  const s = String(pathnameOrUrl || '').toLowerCase()
  return (
    /\.m3u8(\?|$)/i.test(s) ||
    /\.(ts|m4s|aac|mp4|mp3|key)(\?|$)/i.test(s) ||
    /\.pdf(\?|$)/i.test(s) ||
    /\/\d+\.js(\?|$)/i.test(s) ||
    /\/live\//i.test(s) ||
    /\/bridge\//i.test(s)
  )
}

/**
 * Derive a safe provider suffix for rotating subdomains.
 * h37.kavorexacloud.click → kavorexacloud.click
 * bein.mpilalivetv.com → mpilalivetv.com
 * example-provider.test (2 labels) → null (exact host only)
 */
export function deriveCatalogProviderSuffix(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '')
  if (!h || isBlockedHostname(h)) return null
  const labels = h.split('.').filter(Boolean)
  if (labels.length < 3) return null
  const suffix = labels.slice(-2).join('.')
  if (!suffix || isBlockedHostname(suffix)) return null
  return suffix
}

function registerCatalogHttpHost(host) {
  if (!host || isBlockedHostname(host)) return
  catalogHttpHosts.add(host)
  const suffix = deriveCatalogProviderSuffix(host)
  if (suffix) catalogProviderSuffixes.add(suffix)
}

export function syncCatalogHttpBridgeHostsFromChannels(channels = []) {
  const next = new Set()
  const nextSuffixes = new Set()
  for (const ch of channels || []) {
    const player = String(ch.playerType ?? ch.player_type ?? 'exo')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '')
    // Catalog HTTP sources for players that may use backend proxy delivery.
    const proxyEligible =
      !player ||
      ['exo', 'vlc', 'ijk', 'native', 'exoplayer', 'ijkplayer'].includes(player) ||
      player === 'webview' ||
      player === 'chrome'
    if (!proxyEligible && player === 'direct_hls') {
      // Still allowlist HTTP hosts so admin-configured HTTP sources remain bridgeable
      // if player type is later switched to EXO.
    }
    for (const raw of [ch.url, ch.backupStream1, ch.backupStream2, ch.backup_stream_1, ch.backup_stream_2]) {
      const u = String(raw || '').trim()
      if (!u.toLowerCase().startsWith('http://')) continue
      const host = extractUrlHost(u)
      if (!host || isBlockedHostname(host)) continue
      next.add(host)
      const suffix = deriveCatalogProviderSuffix(host)
      if (suffix) nextSuffixes.add(suffix)
    }
  }
  catalogHttpHosts = next
  catalogProviderSuffixes = nextSuffixes
  catalogSyncedAt = Date.now()
  return [...catalogHttpHosts]
}

export function getCatalogHttpBridgeHosts() {
  return [...catalogHttpHosts]
}

export function getCatalogProviderSuffixes() {
  return [...catalogProviderSuffixes]
}

export function noteCatalogHttpBridgeHost(urlOrHost) {
  const host = String(urlOrHost || '').includes('://')
    ? extractUrlHost(urlOrHost)
    : String(urlOrHost || '').trim().toLowerCase()
  if (!host || isBlockedHostname(host)) return
  registerCatalogHttpHost(host)
  catalogSyncedAt = Date.now()
}

function hostMatchesCatalogProviderBoundary(host) {
  if (catalogHttpHosts.has(host)) return true
  for (const suffix of catalogProviderSuffixes) {
    if (hostMatchesDnsLabelSuffix(host, suffix)) return true
  }
  return false
}

function providerSuffixesForAuthorizedRoot(rootHost) {
  const out = new Set()
  if (!rootHost) return out
  const derived = deriveCatalogProviderSuffix(rootHost)
  if (derived) out.add(derived)
  for (const suffix of catalogProviderSuffixes) {
    if (hostMatchesDnsLabelSuffix(rootHost, suffix)) out.add(suffix)
  }
  return out
}

function authorizedRootHosts() {
  const protectedCfg = getProtectedProviderConfig()
  return [
    ...BUILTIN_CLEARTEXT_BRIDGE_HOSTS,
    ...getEnvCleartextHttpBridgeHosts(),
    ...catalogHttpHosts,
    ...protectedCfg.protected_host_suffixes,
  ]
}

export function isAuthorizedStreamRootHost(host) {
  const h = String(host || '').toLowerCase()
  if (!h || isBlockedHostname(h)) return false
  if (hostMatchesAny(h, authorizedRootHosts())) return true
  return hostMatchesCatalogProviderBoundary(h)
}

export function isCleartextHttpBridgeUrl(urlStr) {
  try {
    const u = new URL(String(urlStr || ''))
    if (u.protocol !== 'http:') return false
    const host = u.hostname.toLowerCase()
    if (isBlockedHostname(host)) return false
    if (hostMatchesAny(host, [...BUILTIN_CLEARTEXT_BRIDGE_HOSTS, ...getEnvCleartextHttpBridgeHosts()])) {
      return true
    }
    if (hostMatchesCatalogProviderBoundary(host)) return true
    return false
  } catch {
    return false
  }
}

/**
 * @param {string} urlStr
 * @param {{ referer?: string, rootUpstreamUrl?: string, allowLazyCatalogHost?: string }} [ctx]
 */
export function evaluateStreamProxyUpstreamAccess(urlStr, ctx = {}) {
  let parsed
  try {
    parsed = new URL(String(urlStr || ''))
  } catch {
    return { allowed: false, reason: 'invalid_url', status: 400 }
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { allowed: false, reason: 'unsupported_protocol', status: 400 }
  }

  const host = parsed.hostname.toLowerCase()
  if (isBlockedHostname(host)) {
    return { allowed: false, reason: 'blocked_hostname', status: 403, host }
  }

  if (ctx.allowLazyCatalogHost) {
    const lazy = extractUrlHost(ctx.allowLazyCatalogHost)
    if (lazy && lazy === host) noteCatalogHttpBridgeHost(lazy)
  }

  if (isAuthorizedStreamRootHost(host)) {
    const reason = catalogHttpHosts.has(host)
      ? 'authorized_root'
      : hostMatchesAny(host, [...catalogProviderSuffixes])
        ? 'authorized_catalog_provider_suffix'
        : 'authorized_root'
    return { allowed: true, reason, host }
  }

  // Protected providers (tokenized / known suffixes) even when not in catalog.
  if (isProtectedSegmentTarget(parsed.toString(), { referer: ctx.referer }, { rootUpstreamUrl: ctx.rootUpstreamUrl || ctx.referer })) {
    return { allowed: true, reason: 'protected_provider', host }
  }

  const refererHost = extractUrlHost(ctx.referer || '')
  const rootHost = extractUrlHost(ctx.rootUpstreamUrl || '')
  const authorizedParent =
    (refererHost && isAuthorizedStreamRootHost(refererHost)) ||
    (rootHost && isAuthorizedStreamRootHost(rootHost))

  if (authorizedParent && isHlsMediaPath(parsed.pathname + parsed.search)) {
    // Rotating sibling edge under the same catalog-derived provider boundary.
    const suffixes = providerSuffixesForAuthorizedRoot(rootHost || refererHost)
    for (const suffix of suffixes) {
      if (hostMatchesDnsLabelSuffix(host, suffix)) {
        return {
          allowed: true,
          reason: 'authorized_provider_suffix_segment',
          host,
          parent: refererHost || rootHost,
          provider_suffix: suffix,
        }
      }
    }
    // Preserve existing off-host HLS segment chain (e.g. obfuscated edges under authorized manifest root).
    return { allowed: true, reason: 'authorized_root_segment', host, parent: refererHost || rootHost }
  }

  return { allowed: false, reason: 'host_not_allowlisted', status: 403, host }
}

/**
 * Resolve DNS and reject private/link-local answers (SSRF).
 * @param {string} hostname
 */
export async function assertHostnameResolvesPublic(hostname) {
  const h = String(hostname || '').trim().toLowerCase().replace(/\.$/, '')
  if (!h) throw Object.assign(new Error('empty_host'), { code: 'STREAM_PROXY_SSRF' })
  if (isBlockedHostname(h)) {
    throw Object.assign(new Error('blocked_hostname'), { code: 'STREAM_PROXY_SSRF' })
  }
  if (net.isIP(h)) {
    if (isPrivateOrLocalIp(h)) {
      throw Object.assign(new Error('private_ip'), { code: 'STREAM_PROXY_SSRF' })
    }
    return [h]
  }
  let records
  try {
    records = await dns.lookup(h, { all: true, verbatim: true })
  } catch (e) {
    throw Object.assign(new Error(`dns_failed:${e.message || e}`), { code: 'STREAM_PROXY_DNS' })
  }
  const addrs = (records || []).map((r) => r.address).filter(Boolean)
  if (!addrs.length) {
    throw Object.assign(new Error('dns_empty'), { code: 'STREAM_PROXY_DNS' })
  }
  for (const addr of addrs) {
    if (isPrivateOrLocalIp(addr)) {
      throw Object.assign(new Error(`private_resolved_ip:${addr}`), { code: 'STREAM_PROXY_SSRF' })
    }
  }
  return addrs
}

export function getStreamProxyAllowlistSnapshot() {
  return {
    catalog_http_hosts: getCatalogHttpBridgeHosts(),
    catalog_provider_suffixes: getCatalogProviderSuffixes(),
    catalog_synced_at: catalogSyncedAt || null,
    env_cleartext_hosts: getEnvCleartextHttpBridgeHosts(),
    builtin_cleartext_hosts: BUILTIN_CLEARTEXT_BRIDGE_HOSTS,
    protected_host_suffixes: getProtectedProviderConfig().protected_host_suffixes,
  }
}

/** Test helper */
export function _resetCatalogHttpBridgeHostsForTests(hosts = [], suffixes = null) {
  catalogHttpHosts = new Set((hosts || []).map((h) => String(h).toLowerCase()))
  if (suffixes === null) {
    catalogProviderSuffixes = new Set(
      [...catalogHttpHosts].map((h) => deriveCatalogProviderSuffix(h)).filter(Boolean),
    )
  } else {
    catalogProviderSuffixes = new Set((suffixes || []).map((s) => String(s).toLowerCase()))
  }
  catalogSyncedAt = Date.now()
}
