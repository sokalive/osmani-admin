/**
 * Mirror admin channel/banner uploads from Render → Contabo VPS disk.
 * The static Render SPA historically posted to osmani-admin-api.onrender.com, which
 * wrote images to a different filesystem than Contabo/apps. When running on Render,
 * every persisted upload is also pushed to the VPS ingest endpoint so /uploads paths
 * resolve identically on api.osmanitv.com.
 */
import { isRenderRuntime } from './runtimeHints.js'

function ingestUrl() {
  const explicit = String(process.env.ADMIN_MEDIA_VPS_INGEST_URL || '').trim()
  if (explicit) return explicit
  return 'https://api.osmanitv.com/api/internal/admin-media'
}

function ingestToken() {
  return String(
    process.env.ADMIN_MEDIA_INGEST_TOKEN ||
      process.env.NOTIFICATION_IMAGE_INGEST_TOKEN ||
      process.env.APP_UPDATE_ADMIN_TOKEN ||
      process.env.ADMIN_API_TOKEN ||
      '',
  ).trim()
}

export function shouldMirrorAdminMediaToVps() {
  if (String(process.env.ADMIN_MEDIA_MIRROR_TO_VPS || '').trim() === '0') return false
  if (String(process.env.ADMIN_MEDIA_MIRROR_TO_VPS || '').trim() === '1') return true
  return isRenderRuntime()
}

/**
 * @param {{ filename: string, buffer: Buffer, contentType?: string }} opts
 */
export async function mirrorAdminMediaToVps(opts) {
  if (!shouldMirrorAdminMediaToVps()) return { mirrored: false, skipped: true }
  const filename = String(opts?.filename || '').trim()
  const buffer = opts?.buffer
  if (!filename || !buffer?.length) {
    throw new Error('mirrorAdminMediaToVps requires filename and buffer')
  }
  const token = ingestToken()
  if (!token) {
    throw new Error('ADMIN_MEDIA ingest token is not configured on Render')
  }
  const url = ingestUrl()
  const form = new FormData()
  form.append('filename', filename)
  form.append(
    'image',
    new Blob([buffer], { type: opts.contentType || 'application/octet-stream' }),
    filename,
  )
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Admin-Media-Ingest-Token': token,
      'X-Admin-Token': token,
    },
    body: form,
  })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { raw: text }
  }
  if (!res.ok) {
    throw new Error(`VPS admin-media ingest failed HTTP ${res.status}: ${body?.error || text}`)
  }
  console.log('[admin-media-mirror] mirrored', { filename, bytes: buffer.length, url })
  return { mirrored: true, body }
}
