/**
 * Premium upstream registry — used by stream-proxy/stream-direct to know which
 * URLs require entitlement without trusting the client.
 */
import { readChannels } from '../store.js'

let cache = { at: 0, premiumHosts: new Set(), premiumExact: new Set(), premiumPrefixes: [] }
const CACHE_MS = 30_000

function normalizeUrl(u) {
  try {
    const parsed = new URL(String(u || '').trim())
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
    return parsed
  } catch {
    return null
  }
}

export async function refreshPremiumUpstreamRegistry() {
  const list = await readChannels()
  const premiumHosts = new Set()
  const premiumExact = new Set()
  const premiumPrefixes = []
  for (const c of list || []) {
    const accessType = String(c.accessType || c.access_type || '').toLowerCase()
    const premium =
      accessType === 'premium' || c.accessPremium === true || c.access_premium === true
    if (!premium) continue
    const kind = String(c.channelKind || '').toLowerCase()
    if (kind === 'instruction' || kind === 'instruction_video') continue
    const raw = String(c.url || '').trim()
    const parsed = normalizeUrl(raw)
    if (!parsed) continue
    premiumHosts.add(parsed.hostname.toLowerCase())
    premiumExact.add(parsed.toString())
    // Prefix without query for player.php family
    const bare = `${parsed.origin}${parsed.pathname}`
    if (bare) premiumPrefixes.push(bare)
  }
  cache = { at: Date.now(), premiumHosts, premiumExact, premiumPrefixes }
  return cache
}

async function getRegistry() {
  if (Date.now() - cache.at > CACHE_MS || cache.premiumExact.size === 0) {
    try {
      await refreshPremiumUpstreamRegistry()
    } catch (e) {
      console.error('[premium-upstream-registry] refresh failed:', e)
    }
  }
  return cache
}

/**
 * Returns true if the URL matches a known premium channel upstream.
 */
export async function isKnownPremiumUpstreamUrl(url) {
  const parsed = normalizeUrl(url)
  if (!parsed) return false
  const reg = await getRegistry()
  const full = parsed.toString()
  if (reg.premiumExact.has(full)) return true
  const bare = `${parsed.origin}${parsed.pathname}`
  if (reg.premiumPrefixes.some((p) => bare === p || bare.startsWith(p))) {
    // Only treat as premium if host is in premium set (avoid over-matching)
    return reg.premiumHosts.has(parsed.hostname.toLowerCase())
  }
  // Host-only match for mpingo-style providers when path looks like a player/stream
  if (reg.premiumHosts.has(parsed.hostname.toLowerCase())) {
    const path = parsed.pathname.toLowerCase()
    if (
      path.includes('player') ||
      path.includes('stream') ||
      path.includes('hls') ||
      path.includes('live') ||
      path.includes('/v1/')
    ) {
      return true
    }
  }
  return false
}

export function invalidatePremiumUpstreamRegistry() {
  cache.at = 0
}
