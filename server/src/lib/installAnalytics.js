/**
 * Deduplicated app install rows for analytics (see app_installs unique on device_id + install_instance_id).
 * Used by POST /analytics/install and by presence/subscription paths so totals recover after admin reset.
 */
import { liveSyncBus } from './liveSyncBus.js'

function parseText(v) {
  const s = String(v ?? '').trim()
  return s || null
}

export function sanitizeDeviceIdForInstall(v) {
  const s = parseText(v)
  if (!s) return null
  return s.slice(0, 128)
}

export function sanitizeInstallInstanceIdForInstall(v) {
  const s = parseText(v)
  if (!s) return ''
  return s.slice(0, 128)
}

/**
 * @returns {{ inserted: boolean, deviceId: string | null, installInstanceId: string }}
 */
export async function tryRecordAppInstall(pool, deviceId, installInstanceId = '') {
  const d = sanitizeDeviceIdForInstall(deviceId)
  if (!d) return { inserted: false, deviceId: null, installInstanceId: '' }
  const iid = sanitizeInstallInstanceIdForInstall(installInstanceId)
  const insertRes = await pool.query(
    `INSERT INTO app_installs (device_id, install_instance_id, installed_at)
     VALUES ($1, $2, now())
     ON CONFLICT (device_id, install_instance_id) DO NOTHING
     RETURNING id`,
    [d, iid],
  )
  const inserted = insertRes.rowCount > 0
  if (inserted) {
    liveSyncBus.publish('analytics.install', {
      topics: ['analytics'],
      deviceId: d,
      installInstanceId: iid,
    })
  }
  return { inserted, deviceId: d, installInstanceId: iid }
}
