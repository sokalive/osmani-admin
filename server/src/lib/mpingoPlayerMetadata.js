/**
 * Parse Mpingo player.php embedded stream/DRM vars.
 * Used to route Widevine-only channels away from Android WebView (no EME Widevine).
 */
import { isMpingoPlayerPageUrl } from './streamMpingoHtmlBase.js'

const CACHE_TTL_MS = Math.min(
  15 * 60 * 1000,
  Math.max(60_000, Number(process.env.MPINGO_PLAYER_METADATA_TTL_MS) || 5 * 60 * 1000),
)

const FETCH_UA =
  process.env.MPINGO_PLAYER_FETCH_UA ||
  'Mozilla/5.0 (Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36'

/** @type {Map<string, { expiresAt: number, data: object }>} */
const cache = new Map()

/** In-flight dedupe */
const pending = new Map()

export function parseMpingoPlayerHtml(body) {
  const text = String(body ?? '')
  const pick = (name) => {
    const m = text.match(new RegExp(`var ${name}\\s*=\\s*"([^"]*)"`, 'i'))
    return m ? m[1] : ''
  }
  const streamUrl = pick('streamUrl')
  const clearKey = pick('clearKey')
  return {
    streamUrl,
    streamType: pick('streamType'),
    clearKey,
    detectedIdentity: pick('detectedIdentity'),
    hasStreamUrl: Boolean(streamUrl),
    hasClearKey: Boolean(clearKey),
    needsChromePlayer: Boolean(streamUrl) && !clearKey,
  }
}

export async function fetchMpingoPlayerMetadata(playerUrl) {
  const url = String(playerUrl || '').trim()
  if (!isMpingoPlayerPageUrl(url)) return null

  const cached = cache.get(url)
  if (cached && Date.now() < cached.expiresAt) return cached.data

  if (pending.has(url)) return pending.get(url)

  const job = (async () => {
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': FETCH_UA,
          Referer: 'https://nur.mpingotv.com',
          Origin: 'https://nur.mpingotv.com',
        },
        signal: AbortSignal.timeout(20_000),
      })
      const body = await r.text()
      const data = {
        ...parseMpingoPlayerHtml(body),
        status: r.status,
        fetched_at: new Date().toISOString(),
        player_url: url,
      }
      cache.set(url, { data, expiresAt: Date.now() + CACHE_TTL_MS })
      return data
    } catch (e) {
      const data = {
        streamUrl: '',
        streamType: '',
        clearKey: '',
        detectedIdentity: '',
        hasStreamUrl: false,
        hasClearKey: false,
        needsChromePlayer: false,
        error: String(e.message || e),
        fetched_at: new Date().toISOString(),
        player_url: url,
      }
      cache.set(url, { data, expiresAt: Date.now() + 30_000 })
      return data
    } finally {
      pending.delete(url)
    }
  })()

  pending.set(url, job)
  return job
}

export function getCachedMpingoPlayerMetadata(playerUrl) {
  const url = String(playerUrl || '').trim()
  const entry = cache.get(url)
  if (!entry || Date.now() >= entry.expiresAt) return null
  return entry.data
}

export function collectMpingoPlayerUrls(channels) {
  const urls = new Set()
  for (const ch of channels || []) {
    const url = String(ch?.url || '').trim()
    if (isMpingoPlayerPageUrl(url)) urls.add(url)
  }
  return [...urls]
}

export async function warmMpingoMetadataCache(channels) {
  const urls = collectMpingoPlayerUrls(channels)
  await Promise.all(urls.map((u) => fetchMpingoPlayerMetadata(u)))
}

/** WebView Shaka ClearKey works; empty clearKey forces Widevine which WebView lacks (Shaka 6001). */
export function mpingoNeedsChromePlayer(meta) {
  return Boolean(meta?.needsChromePlayer)
}

/** Test-only cache seeding */
export function __setMpingoMetadataCacheForTest(playerUrl, data, ttlMs = CACHE_TTL_MS) {
  cache.set(String(playerUrl), { data, expiresAt: Date.now() + ttlMs })
}

export function __clearMpingoMetadataCacheForTest() {
  cache.clear()
  pending.clear()
}
