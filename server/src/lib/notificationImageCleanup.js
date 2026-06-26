import fs from 'node:fs/promises'
import path from 'node:path'
import { getPool } from '../db/pool.js'
import { UPLOADS_DIR } from '../multerUpload.js'
import { isNotificationImageStorageHost } from './notificationImageStorage.js'

const NOTIF_FILE_RE = /^notif-[a-z0-9.-]+\.(jpe?g|png|webp)$/i

function retentionMs() {
  const days = Math.max(1, Number(process.env.NOTIFICATION_IMAGE_RETENTION_DAYS) || 90)
  return days * 24 * 60 * 60 * 1000
}

async function listNotificationImageFiles() {
  let names = []
  try {
    names = await fs.readdir(UPLOADS_DIR)
  } catch {
    return []
  }
  const files = []
  for (const name of names) {
    if (!NOTIF_FILE_RE.test(name)) continue
    const full = path.join(UPLOADS_DIR, name)
    try {
      const st = await fs.stat(full)
      if (st.isFile()) {
        files.push({ name, full, mtimeMs: st.mtimeMs, size: st.size })
      }
    } catch {
      /* skip */
    }
  }
  return files
}

async function loadReferencedNotificationImagePaths(pool) {
  const { rows } = await pool.query(
    `SELECT image FROM notifications WHERE image IS NOT NULL AND image <> '' AND image LIKE '/uploads/notif-%'`,
  )
  const referenced = new Set()
  for (const row of rows) {
    const raw = String(row.image ?? '').trim()
    if (!raw) continue
    const base = raw.split('/').pop()
    if (base) referenced.add(base)
    referenced.add(raw)
    referenced.add(`/uploads/${base}`)
  }
  return referenced
}

export async function cleanupOrphanedNotificationImages() {
  if (!isNotificationImageStorageHost()) {
    return { skipped: true, reason: 'not_storage_host' }
  }

  const pool = getPool()
  if (!pool) {
    return { skipped: true, reason: 'no_database' }
  }

  const cutoff = Date.now() - retentionMs()
  const referenced = await loadReferencedNotificationImagePaths(pool)
  const files = await listNotificationImageFiles()

  let deleted = 0
  let reclaimedBytes = 0
  const errors = []

  for (const file of files) {
    const rel = `/uploads/${file.name}`
    const inUse = referenced.has(file.name) || referenced.has(rel)
    if (inUse) continue
    if (file.mtimeMs > cutoff) continue
    try {
      await fs.unlink(file.full)
      deleted += 1
      reclaimedBytes += file.size
    } catch (e) {
      errors.push({ file: file.name, error: String(e?.message || e) })
    }
  }

  if (deleted > 0) {
    console.log('[notification-image-cleanup] removed orphaned files', {
      deleted,
      reclaimedBytes,
      retentionDays: Math.round(retentionMs() / (24 * 60 * 60 * 1000)),
    })
  }

  return { deleted, reclaimedBytes, scanned: files.length, errors }
}

let cleanupTimer = null

export function scheduleNotificationImageCleanup() {
  if (!isNotificationImageStorageHost()) return
  if (cleanupTimer) return

  const intervalMs = Math.max(
    60 * 60 * 1000,
    Number(process.env.NOTIFICATION_IMAGE_CLEANUP_INTERVAL_MS) || 24 * 60 * 60 * 1000,
  )

  const run = () => {
    void cleanupOrphanedNotificationImages().catch((e) => {
      console.error('[notification-image-cleanup] failed:', e?.message || e)
    })
  }

  run()
  cleanupTimer = setInterval(run, intervalMs)
  if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref()
  console.log(`[notification-image-cleanup] scheduled every ${intervalMs}ms`)
}
