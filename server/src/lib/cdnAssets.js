/**
 * Bunny CDN (b-cdn.net) URL resolution for static uploads.
 * DB and ingest keep `/uploads/...` paths; APIs emit absolute CDN URLs when configured.
 *
 * OTA APKs under `/uploads/apks/` stay on the API origin (BASE_URL) — unchanged behavior.
 */

const DEFAULT_ORIGIN_BASE = 'https://osmani-admin-api.onrender.com'

const DEFAULT_STATIC_MAX_AGE_SEC = Math.max(
  0,
  Number(process.env.BUNNY_CDN_STATIC_MAX_AGE_SEC) || 31_536_000,
)

/** Hostnames that should be rewritten to the CDN on API read (legacy Render absolute URLs). */
const BUILTIN_LEGACY_HOSTS = new Set([
  'osmani-admin-api.onrender.com',
  'osmani-admin-mpya.onrender.com',
])

function trimSlash(s) {
  return String(s ?? '').trim().replace(/\/+$/, '')
}

function parseExtraLegacyHosts() {
  const raw = String(process.env.ASSET_LEGACY_ORIGIN_HOSTS || '').trim()
  if (!raw) return []
  return raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
}

function legacyOriginHosts() {
  const hosts = new Set(BUILTIN_LEGACY_HOSTS)
  for (const h of parseExtraLegacyHosts()) hosts.add(h)
  try {
    const base = trimSlash(process.env.BASE_URL || process.env.ASSET_ORIGIN_URL || '')
    if (base) hosts.add(new URL(base).hostname.toLowerCase())
  } catch {
    /* ignore */
  }
  return hosts
}

function isBunnyCdnHost(hostname) {
  return String(hostname || '').toLowerCase().endsWith('.b-cdn.net')
}

/**
 * Public CDN base (e.g. https://your-zone.b-cdn.net). Empty when not configured.
 */
export function getCdnBaseUrl() {
  const raw = String(process.env.BUNNY_CDN_BASE_URL || process.env.BUNNY_CDN_URL || '').trim()
  if (!raw) return ''
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`)
    return `${u.protocol}//${u.host}`.replace(/\/$/, '')
  } catch {
    return trimSlash(raw)
  }
}

export function isCdnEnabled() {
  return Boolean(getCdnBaseUrl())
}

/**
 * API origin used for fallbacks and APK hosting (Render).
 */
export function getOriginBaseUrl(req) {
  const fromEnv = trimSlash(process.env.BASE_URL || process.env.ASSET_ORIGIN_URL || '')
  if (fromEnv) return fromEnv
  if (req) {
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0]
    const host = String(req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim()
    if (host) return `${proto}://${host}`.replace(/\/$/, '')
  }
  return DEFAULT_ORIGIN_BASE
}

export function getStaticUploadCacheMaxAgeSec() {
  if (!isCdnEnabled()) return 0
  return DEFAULT_STATIC_MAX_AGE_SEC
}

/** APK / OTA binaries must not be moved to the image CDN layer. */
export function isOriginOnlyUploadPath(pathOrUrl) {
  const p = extractUploadPath(pathOrUrl) || String(pathOrUrl || '')
  return p.includes('/uploads/apks/')
}

/**
 * Normalize any stored value to a canonical `/uploads/...` path when possible.
 */
export function extractUploadPath(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  if (raw.startsWith('/uploads/')) return raw.split('?')[0]
  if (raw.startsWith('uploads/')) return `/${raw.split('?')[0]}`
  try {
    const parsed = new URL(raw)
    if (parsed.pathname.startsWith('/uploads/')) {
      return parsed.pathname.split('?')[0]
    }
  } catch {
    /* not a URL */
  }
  return ''
}

function buildAbsoluteUrl(base, pathname) {
  const baseUrl = trimSlash(base)
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`
  return `${baseUrl}${path}`
}

function rewriteLegacyAbsoluteUrl(absoluteUrl) {
  const uploadPath = extractUploadPath(absoluteUrl)
  if (!uploadPath) return absoluteUrl
  if (isOriginOnlyUploadPath(uploadPath)) {
    return buildAbsoluteUrl(getOriginBaseUrl(null), uploadPath)
  }
  const cdn = getCdnBaseUrl()
  if (cdn) return buildAbsoluteUrl(cdn, uploadPath)
  return absoluteUrl
}

/**
 * Resolve a stored path or absolute URL for API clients and push notifications.
 *
 * @param {string|null|undefined} value - `/uploads/...`, legacy Render URL, external https, etc.
 * @param {import('express').Request|null} [req]
 * @param {{ forceOrigin?: boolean }} [opts] - force API origin (APKs, health probes)
 */
export function resolvePublicAssetUrl(value, req, opts = {}) {
  if (value == null) return null
  const rel = String(value).trim()
  if (rel === '') return null

  if (rel.startsWith('data:')) return rel

  const uploadPath = extractUploadPath(rel)
  const forceOrigin = Boolean(opts.forceOrigin)

  if (uploadPath && isOriginOnlyUploadPath(uploadPath)) {
    if (rel.startsWith('http://') || rel.startsWith('https://')) {
      try {
        const u = new URL(rel)
        if (isBunnyCdnHost(u.hostname)) {
          return buildAbsoluteUrl(getOriginBaseUrl(req), uploadPath)
        }
      } catch {
        /* fall through */
      }
    }
    return buildAbsoluteUrl(getOriginBaseUrl(req), uploadPath)
  }

  if (rel.startsWith('http://') || rel.startsWith('https://')) {
    try {
      const parsed = new URL(rel)
      if (isBunnyCdnHost(parsed.hostname)) {
        return forceOrigin && uploadPath
          ? buildAbsoluteUrl(getOriginBaseUrl(req), uploadPath)
          : rel
      }
      if (uploadPath && legacyOriginHosts().has(parsed.hostname.toLowerCase())) {
        if (forceOrigin) return buildAbsoluteUrl(getOriginBaseUrl(req), uploadPath)
        return rewriteLegacyAbsoluteUrl(rel)
      }
    } catch {
      return rel
    }
    return rel
  }

  const originBase = getOriginBaseUrl(req)
  const cdnBase = getCdnBaseUrl()

  if (uploadPath) {
    if (forceOrigin || !cdnBase) return buildAbsoluteUrl(originBase, uploadPath)
    return buildAbsoluteUrl(cdnBase, uploadPath)
  }

  if (rel.startsWith('/uploads')) {
    const path = rel.split('?')[0]
    if (forceOrigin || !cdnBase) return buildAbsoluteUrl(originBase, path)
    return buildAbsoluteUrl(cdnBase, path)
  }

  const host = req ? `${req.protocol}://${req.get('host') || ''}`.replace(/\/$/, '') : ''
  if (rel.startsWith('/') && host) {
    return `${host}${rel}`
  }
  if (rel.startsWith('/')) {
    return buildAbsoluteUrl(originBase, rel)
  }
  return `${originBase}/${rel.replace(/^\/+/, '')}`
}

export function getCdnHealthSnapshot() {
  const cdnBase = getCdnBaseUrl()
  const originBase = getOriginBaseUrl(null)
  return {
    cdnEnabled: Boolean(cdnBase),
    cdnBaseUrl: cdnBase || null,
    originBaseUrl: originBase,
    staticMaxAgeSec: getStaticUploadCacheMaxAgeSec(),
    originOnlyPaths: ['/uploads/apks/*'],
    legacyOriginHosts: [...legacyOriginHosts()],
  }
}

/** Asset path prefixes migrated to Bunny when CDN is enabled. */
export const MIGRATED_UPLOAD_PREFIXES = [
  '/uploads/*.jpg',
  '/uploads/*.jpeg',
  '/uploads/*.png',
  '/uploads/*.gif',
  '/uploads/*.webp',
  '/uploads/*.avif',
  '/uploads/notif-*',
  'channel thumbnails (DB field: thumbnail)',
  'banner images (DB field: image)',
  'payment provider logos (DB field: logo_path)',
  'notification images (DB field: image)',
]
