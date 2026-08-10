import { tryRecordAppInstall } from './installAnalytics.js'
import { resolveAnalyticsChannelRef } from './channelAnalyticsNormalize.js'

function parseText(v) {
  const s = String(v ?? '').trim()
  return s || null
}

function parseDeviceId(v) {
  const s = parseText(v)
  if (!s) return null
  return s.slice(0, 128)
}

function parseInstallInstanceIdFromBody(body) {
  const b = body && typeof body === 'object' ? body : {}
  const raw = b.install_instance_id ?? b.installInstanceId ?? b.install_id ?? b.installId
  const s = parseText(raw)
  return s ? s.slice(0, 128) : ''
}

/**
 * Upsert live_sessions with canonical channel id (shared by Render + VPS writers).
 */
export async function upsertLiveSession(
  pool,
  {
    deviceId,
    channelId = null,
    channelName = null,
    country = null,
    installBody = null,
    clearChannel = false,
  },
) {
  const d = parseDeviceId(deviceId)
  if (!d) throw new Error('device_id is required')

  const resolvedChannel = clearChannel
    ? null
    : await resolveAnalyticsChannelRef(pool, { channelId, channelName })
  const safeCountry = country ? String(country).slice(0, 120) : null

  await pool.query(
    `INSERT INTO live_sessions (device_id, channel_id, country, started_at, updated_at)
     VALUES ($1, $2, $3, now(), now())
     ON CONFLICT (device_id) DO UPDATE SET
       channel_id = CASE
         WHEN $4::boolean THEN NULL
         WHEN EXCLUDED.channel_id IS NOT NULL AND trim(EXCLUDED.channel_id) <> ''
           THEN EXCLUDED.channel_id
         ELSE live_sessions.channel_id
       END,
       country = COALESCE(EXCLUDED.country, live_sessions.country),
       updated_at = now()`,
    [d, resolvedChannel, safeCountry, clearChannel === true],
  )

  const body = installBody && typeof installBody === 'object' ? installBody : {}
  const iid = parseInstallInstanceIdFromBody(body)
  void tryRecordAppInstall(pool, d, iid).catch((e) => {
    console.error('[liveSessionStore] tryRecordAppInstall:', e)
  })

  return { deviceId: d, channelId: resolvedChannel, country: safeCountry }
}

export async function removeLiveSession(pool, deviceId) {
  const d = parseDeviceId(deviceId)
  if (!d) throw new Error('device_id is required')
  await pool.query(`DELETE FROM live_sessions WHERE device_id = $1`, [d])
  return { deviceId: d }
}
