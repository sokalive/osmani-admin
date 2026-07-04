/**
 * Bunny CDN (b-cdn.net) URL resolution for static uploads (images + APKs).
 * DB may store `/uploads/...` or legacy Render absolute URLs; APIs emit Bunny when configured.
 * Files remain on disk at UPLOAD_DIR; Bunny pull zone origin = BASE_URL.
 */

import { defaultPublicApiOrigin } from './deployMeta.js'

const DEFAULT_ORIGIN_BASE = defaultPublicApiOrigin()

const DEFAULT_STATIC_MAX_AGE_SEC = Math.max(
  0,
  Number(process.env.BUNNY_CDN_STATIC_MAX_AGE_SEC) || 31_536_000,
)

/** Hostnames rewritten to CDN on API read (legacy absolute URLs). */
const BUILTIN_LEGACY_HOSTS = new Set([
  'osmani-admin-api.onrender.com',
  'osmani-admin-mpya.onrender.com',
  '144.91.117.90',
  'localhost',
  '127.0.0.1',
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

export function isBunnyCdnHost(hostname) {
  return String(hostname || '').toLowerCase().endsWith('.b-cdn.net')
}

/**
 * True when the request is Bunny CDN origin-pull (not a browser/client).
 * Origin must return file bytes with 200 — a 302 back to b-cdn.net causes a redirect loop.
 */
export function isBunnyCdnOriginPullRequest(req) {
  if (!req?.headers) return false
  const h = req.headers
  if (h['cdn-pullzone'] || h['pull-zone'] || h['x-bunny-pull']) return true
  const via = String(h.via || '').toLowerCase()
  if (via.includes('bunny')) return true
  const ua = String(h['user-agent'] || '').toLowerCase()
  if (ua.includes('bunnycdn') || ua.includes('bunny-cdn')) return true
  return false
}

/**
 * Public CDN base (e.g. https://your-zone.b-cdn.net). Empty when not configured.
 */
export function getCdnBaseUrl() {
  const raw = String(process.env.BUNNY_CDN_BASE_URL || process.env.BUNNY_CDN_URL || '').trim()
  if (raw) {
    try {
      const u = new URL(raw.includes('://') ? raw : `https://${raw}`)
      return `${u.protocol}//${u.host}`.replace(/\/$/, '')
    } catch {
      return trimSlash(raw)
    }
  }
  // Contabo VPS cutover: thumbnails live on Bunny (origin disk is empty on Contabo).
  const uploadDir = String(process.env.UPLOAD_DIR || '').toLowerCase()
  const baseUrl = String(process.env.BASE_URL || '').toLowerCase()
  if (uploadDir.includes('osmani-admin-api') || baseUrl.includes('144.91.117.90')) {
    return 'https://osmanitv.b-cdn.net'
  }
  return ''
}

export function isCdnEnabled() {
  return Boolean(getCdnBaseUrl())
}

/** API origin (Render) — Bunny pull zone origin + upload ingest target. */
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

/** @deprecated All /uploads/* including apks use CDN when enabled. */
export function isOriginOnlyUploadPath(pathOrUrl) {
  return false
}

export function isHostedApkPath(pathOrUrl) {
  const p = extractUploadPath(pathOrUrl) || String(pathOrUrl || '')
  return p.includes('/uploads/apks/')
}

/** True when this process stores uploads on Contabo VPS disk (not Render ephemeral). */
export function uploadsStoredOnVpsDisk() {
  if (String(process.env.OSMANI_VPS || '').trim() === '1') return true
  const uploadDir = String(process.env.UPLOAD_DIR || '').toLowerCase()
  if (uploadDir.includes('osmani-admin-api') || uploadDir.includes('/var/www/')) return true
  return false
}

/**
 * Channel/banner/logo images on VPS must use API origin URLs until Bunny pull origin
 * points at api.osmanitv.com. APKs may still use CDN when configured.
 */
export function shouldDeliverUploadViaOrigin(uploadPath = '') {
  if (String(process.env.UPLOADS_SERVE_FROM_ORIGIN || '').trim() === '1') return true
  if (isHostedApkPath(uploadPath)) return false
  if (uploadsStoredOnVpsDisk()) return true
  return false
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
  const cdn = getCdnBaseUrl()
  if (cdn) return buildAbsoluteUrl(cdn, uploadPath)
  return absoluteUrl
}

/**
 * OTA / app-update hosted APK URLs (`/uploads/apks/*` only). Play Store URLs pass through unchanged.
 */
export function resolveHostedApkDownloadUrl(value, req = null) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  if (!isHostedApkPath(raw)) return raw
  const resolved = resolvePublicAssetUrl(raw, req)
  return resolved != null ? String(resolved) : raw
}

/**
 * Resolve a stored path or absolute URL for API clients.
 *
 * @param {string|null|undefined} value
 * @param {import('express').Request|null} [req]
 * @param {{ forceOrigin?: boolean }} [opts] - force API origin (internal probes only)
 */
export function resolvePublicAssetUrl(value, req, opts = {}) {
  if (value == null) return null
  const rel = String(value).trim()
  if (rel === '') return null

  if (rel.startsWith('data:')) return rel

  const uploadPath = extractUploadPath(rel)
  const forceOrigin = Boolean(opts.forceOrigin)

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
    if (forceOrigin || !cdnBase || shouldDeliverUploadViaOrigin(uploadPath)) {
      return buildAbsoluteUrl(originBase, uploadPath)
    }
    return buildAbsoluteUrl(cdnBase, uploadPath)
  }

  if (rel.startsWith('/uploads')) {
    const pathOnly = rel.split('?')[0]
    if (forceOrigin || !cdnBase || shouldDeliverUploadViaOrigin(pathOnly)) {
      return buildAbsoluteUrl(originBase, pathOnly)
    }
    return buildAbsoluteUrl(cdnBase, pathOnly)
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
    apkDeliveryViaCdn: Boolean(cdnBase),
    legacyOriginHosts: [...legacyOriginHosts()],
  }
}

/** Asset path prefixes served via Bunny when CDN is enabled. */
export const MIGRATED_UPLOAD_PREFIXES = [
  '/uploads/*.jpg',
  '/uploads/*.jpeg',
  '/uploads/*.png',
  '/uploads/*.gif',
  '/uploads/*.webp',
  '/uploads/*.avif',
  '/uploads/notif-*',
  '/uploads/apks/*.apk',
  'channel thumbnails (thumbnail / thumbnailUrl)',
  'banner images (image / image_url / imageUrl)',
  'payment provider logos (logoUrl)',
  'notification images (image)',
  'OTA APK downloads (apk_url / apkUrl)',
]
