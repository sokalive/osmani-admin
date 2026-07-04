/**
 * Notification image persistence — always on Contabo VPS disk, never Render local storage.
 * Render (and any remote mode) uploads optimized bytes to the VPS ingest API.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { extractUploadPath, getCdnBaseUrl } from './cdnAssets.js'
import { ensureUploadsDir, UPLOADS_DIR } from './uploadPaths.js'
import { isRenderRuntime } from './startupReadiness.js'
import { assertDiskSpaceForWrite, isEnospcError, UploadDiskError } from './uploadDiskSafety.js'

const NOTIFICATION_IMAGE_PREFIX = 'notif-'

function trimSlash(s) {
  return String(s ?? '').trim().replace(/\/+$/, '')
}

export function isNotificationImageUploadPath(value) {
  const p = extractUploadPath(value) || String(value ?? '').trim()
  return /\/uploads\/notif-[^/]+\.(jpe?g|png|webp)$/i.test(p)
}

/** Public HTTPS origin for notification images (VPS API — never Render). */
export function getNotificationImagePublicOrigin() {
  const explicit = trimSlash(process.env.NOTIFICATION_IMAGE_PUBLIC_ORIGIN)
  if (explicit) return explicit
  return 'https://api.osmanitv.com'
}

/** True when this process must not write notification images to local UPLOAD_DIR. */
export function mustUseRemoteNotificationImageStorage() {
  const mode = String(process.env.NOTIFICATION_IMAGE_STORAGE || '').trim().toLowerCase()
  if (mode === 'local') return false
  if (mode === 'remote' || mode === 'vps') return true
  if (isRenderRuntime()) return true
  if (String(process.env.NOTIFICATION_IMAGE_VPS_INGEST_URL || '').trim()) return true
  return false
}

/** True on the VPS host that owns notification image files on disk. */
export function isNotificationImageStorageHost() {
  return !mustUseRemoteNotificationImageStorage()
}

export function getNotificationImageIngestToken() {
  return String(
    process.env.NOTIFICATION_IMAGE_INGEST_TOKEN ||
      process.env.ADMIN_API_TOKEN ||
      process.env.APP_UPDATE_ADMIN_TOKEN ||
      '',
  ).trim()
}

export function getNotificationImageVpsIngestUrl() {
  const explicit = String(process.env.NOTIFICATION_IMAGE_VPS_INGEST_URL || '').trim()
  if (explicit) return explicit.replace(/\/+$/, '')
  if (mustUseRemoteNotificationImageStorage()) {
    return `${getNotificationImagePublicOrigin()}/api/internal/notification-images`
  }
  return ''
}

export function buildNotificationImageFilename(ext) {
  const safeExt = String(ext || 'jpg').replace(/^\./, '').toLowerCase()
  const ts = Date.now()
  const rand = Math.random().toString(16).slice(2, 10)
  return `${NOTIFICATION_IMAGE_PREFIX}${ts}-${rand}.${safeExt}`
}

export function notificationImageRelativePath(filename) {
  const base = String(filename ?? '')
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .pop()
  if (!base || !base.startsWith(NOTIFICATION_IMAGE_PREFIX)) return ''
  return `/uploads/${base}`
}

/**
 * HTTPS URL for OneSignal / mobile clients — always VPS origin or Bunny CDN, never Render disk.
 */
export function resolveNotificationImagePublicUrl(storedPath) {
  const raw = String(storedPath ?? '').trim()
  if (!raw) return ''
  if (raw.startsWith('https://')) {
    if (raw.includes('onrender.com') && isNotificationImageUploadPath(raw)) {
      const uploadPath = extractUploadPath(raw)
      if (uploadPath) return resolveNotificationImagePublicUrl(uploadPath)
    }
    return raw
  }
  const uploadPath = extractUploadPath(raw) || (raw.startsWith('/uploads/') ? raw.split('?')[0] : '')
  if (!uploadPath || !isNotificationImageUploadPath(uploadPath)) {
    return ''
  }
  // notif-* files live on VPS disk only. Bunny pull zone still origins from Render, so b-cdn.net
  // returns 404 for these paths — OneSignal cannot fetch the image from CDN.
  return `${getNotificationImagePublicOrigin()}${uploadPath}`
}

/**
 * Best public URL for in-app notification history (admin + runtime API).
 * Prefer Bunny CDN when the object is reachable there; otherwise VPS origin.
 */
export async function resolveNotificationImageDisplayUrl(storedPath) {
  const originUrl = resolveNotificationImagePublicUrl(storedPath)
  if (!originUrl) return ''
  const cdnBase = getCdnBaseUrl()
  if (!cdnBase) return originUrl
  const uploadPath = extractUploadPath(storedPath) || ''
  if (!uploadPath) return originUrl
  const cdnUrl = `${trimSlash(cdnBase)}${uploadPath}`
  try {
    const res = await fetch(cdnUrl, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(5000),
    })
    if (res.ok) return cdnUrl
  } catch {
    /* CDN miss — use VPS origin */
  }
  return originUrl
}

function contentTypeForExt(ext) {
  const e = String(ext || '').toLowerCase()
  if (e === 'png') return 'image/png'
  if (e === 'webp') return 'image/webp'
  return 'image/jpeg'
}

export async function writeNotificationImageLocal(buffer, filename) {
  if (mustUseRemoteNotificationImageStorage()) {
    throw new Error(
      'Notification image local write blocked — images must be stored on VPS (remote mode)',
    )
  }
  ensureUploadsDir()
  const name = path.basename(String(filename || '').trim())
  if (!name.startsWith(NOTIFICATION_IMAGE_PREFIX)) {
    throw new Error('Invalid notification image filename')
  }
  const full = path.join(UPLOADS_DIR, name)
  assertDiskSpaceForWrite(full, buffer.length)
  try {
    await fs.writeFile(full, buffer)
  } catch (e) {
    if (isEnospcError(e)) {
      await fs.unlink(full).catch(() => {})
      throw new UploadDiskError(
        'UPLOAD_DISK_FULL',
        'Server storage is full. Image upload is temporarily unavailable. Contact support.',
        { path: full, cause: e },
      )
    }
    throw e
  }
  return {
    imageForDb: notificationImageRelativePath(name),
    bytes: buffer.length,
    storage: 'vps-local',
  }
}

export async function uploadNotificationImageToVps(buffer, filename, { ext = 'jpg' } = {}) {
  const ingestUrl = getNotificationImageVpsIngestUrl()
  const token = getNotificationImageIngestToken()
  if (!ingestUrl) {
    throw new Error('NOTIFICATION_IMAGE_VPS_INGEST_URL is not configured')
  }
  if (!token) {
    throw new Error('NOTIFICATION_IMAGE_INGEST_TOKEN (or ADMIN_API_TOKEN) is not configured')
  }

  const name = path.basename(String(filename || '').trim())
  const form = new FormData()
  form.append('filename', name)
  form.append('image', new Blob([buffer], { type: contentTypeForExt(ext) }), name)

  const res = await fetch(ingestUrl, {
    method: 'POST',
    headers: {
      'X-Notification-Ingest-Token': token,
    },
    body: form,
    signal: AbortSignal.timeout(
      Math.max(15_000, Number(process.env.NOTIFICATION_IMAGE_INGEST_TIMEOUT_MS) || 60_000),
    ),
  })

  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { raw: text.slice(0, 200) }
  }

  if (!res.ok) {
    throw new Error(
      `VPS notification image ingest failed (${res.status}): ${body?.error || text.slice(0, 200)}`,
    )
  }

  const imageForDb = String(body?.imageForDb || body?.image || '').trim()
  if (!imageForDb.startsWith('/uploads/')) {
    throw new Error('VPS ingest returned invalid image path')
  }

  return {
    imageForDb,
    bytes: buffer.length,
    storage: 'vps-remote',
    ingestUrl,
  }
}

/**
 * Persist optimized notification image bytes — VPS disk only (local or remote ingest).
 */
export async function storeOptimizedNotificationImage(buffer, { ext = 'jpg' } = {}) {
  const filename = buildNotificationImageFilename(ext)
  if (mustUseRemoteNotificationImageStorage()) {
    return uploadNotificationImageToVps(buffer, filename, { ext })
  }
  return writeNotificationImageLocal(buffer, filename)
}

export function getNotificationImageStorageDiagnostics() {
  return {
    mode: mustUseRemoteNotificationImageStorage() ? 'remote' : 'local',
    renderRuntime: isRenderRuntime(),
    storageHost: isNotificationImageStorageHost(),
    ingestUrl: getNotificationImageVpsIngestUrl() || null,
    publicOrigin: getNotificationImagePublicOrigin(),
    uploadsDir: isNotificationImageStorageHost() ? UPLOADS_DIR : null,
    renderDiskUsed: false,
  }
}
