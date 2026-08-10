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

function normChannel(v) {
  const s = String(v ?? '').trim()
  return s || null
}

/**
 * Upsert live_sessions with canonical channel id (shared by Render + VPS writers).
 * Returns previous vs new channel state so callers can emit presence_changed only
 * when online/watching/idle meaningfully changes (not on routine TTL heartbeat).
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

  const { rows } = await pool.query(
    `WITH prev AS (
       SELECT device_id, channel_id
       FROM live_sessions
       WHERE device_id = $1
     ),
     upserted AS (
       INSERT INTO live_sessions (device_id, channel_id, country, started_at, updated_at)
       VALUES ($1, $2, $3, now(), now())
       ON CONFLICT (device_id) DO UPDATE SET
         channel_id = CASE
           WHEN $4::boolean THEN NULL
           WHEN EXCLUDED.channel_id IS NOT NULL AND trim(EXCLUDED.channel_id) <> ''
             THEN EXCLUDED.channel_id
           ELSE live_sessions.channel_id
         END,
         country = COALESCE(EXCLUDED.country, live_sessions.country),
         updated_at = now()
       RETURNING device_id, channel_id
     )
     SELECT
       u.device_id,
       u.channel_id AS channel_id,
       p.channel_id AS previous_channel_id,
       (p.device_id IS NULL) AS created
     FROM upserted u
     LEFT JOIN prev p ON p.device_id = u.device_id`,
    [d, resolvedChannel, safeCountry, clearChannel === true],
  )

  const row = rows[0] || {}
  const previousChannelId = normChannel(row.previous_channel_id)
  const storedChannelId = normChannel(row.channel_id)
  const created = row.created === true
  const channelChanged = previousChannelId !== storedChannelId
  const presenceChanged = created || channelChanged

  const body = installBody && typeof installBody === 'object' ? installBody : {}
  const iid = parseInstallInstanceIdFromBody(body)
  void tryRecordAppInstall(pool, d, iid).catch((e) => {
    console.error('[liveSessionStore] tryRecordAppInstall:', e)
  })

  return {
    deviceId: d,
    channelId: storedChannelId,
    country: safeCountry,
    previousChannelId,
    created,
    channelChanged,
    presenceChanged,
  }
}

export async function removeLiveSession(pool, deviceId) {
  const d = parseDeviceId(deviceId)
  if (!d) throw new Error('device_id is required')
  const { rowCount } = await pool.query(`DELETE FROM live_sessions WHERE device_id = $1`, [d])
  return { deviceId: d, removed: (rowCount || 0) > 0, presenceChanged: (rowCount || 0) > 0 }
}
