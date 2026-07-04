import { getPool } from '../db/pool.js'
import { liveSyncBus } from './liveSyncBus.js'

export const OMBA_KIFURUSHI_SETTING_KEY = 'omba_kifurushi_enabled'
export const OMBA_KIFURUSHI_DISABLED_MESSAGE_SW =
  'Huduma hii imezuiliwa na Admin kwa sasa. Wasiliana na muhudumu kwa msaada zaidi.'

let _cache = null
let _cacheAt = 0
const CACHE_MS = Math.max(500, Math.min(60_000, Number(process.env.OMBA_KIFURUSHI_CACHE_MS) || 1500))

export function invalidateOmbaKifurushiCache() {
  _cache = null
  _cacheAt = 0
}

function parseEnabled(raw) {
  const v = String(raw ?? '').trim().toLowerCase()
  if (v === 'false' || v === '0' || v === 'off' || v === 'disabled') return false
  return true
}

export async function readOmbaKifurushiEnabled(pool = null) {
  const now = Date.now()
  if (!pool && _cache != null && now - _cacheAt < CACHE_MS) return _cache
  const p = pool || getPool()
  if (!p) return true
  const { rows } = await p.query(`SELECT value, updated_at FROM app_settings WHERE key = $1 LIMIT 1`, [
    OMBA_KIFURUSHI_SETTING_KEY,
  ])
  const enabled = rows[0] ? parseEnabled(rows[0].value) : true
  if (!pool) {
    _cache = enabled
    _cacheAt = now
  }
  return enabled
}

export async function writeOmbaKifurushiEnabled(pool, enabled, updatedBy = 'admin') {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [OMBA_KIFURUSHI_SETTING_KEY, enabled ? 'true' : 'false'],
  )
  await pool.query(
    `INSERT INTO subscription_request_settings (id, enabled, updated_by, updated_at)
     VALUES (1, $1, $2, now())
     ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [enabled, String(updatedBy).slice(0, 256)],
  )
  invalidateOmbaKifurushiCache()
  _cache = enabled === true
  _cacheAt = Date.now()
}

export async function loadOmbaKifurushiPublicPayload() {
  const enabled = await readOmbaKifurushiEnabled()
  const snap = liveSyncBus.snapshot()
  return {
    ok: true,
    v: snap.configVersion,
    omba_kifurushi_enabled: enabled,
    ombaKifurushiEnabled: enabled,
    disabled_message_sw: OMBA_KIFURUSHI_DISABLED_MESSAGE_SW,
    disabledMessageSw: OMBA_KIFURUSHI_DISABLED_MESSAGE_SW,
    server_time_ms: Date.now(),
  }
}

export function publishOmbaKifurushiChanged(enabled) {
  liveSyncBus.publish('omba_kifurushi_settings_changed', {
    topics: ['config'],
    omba_kifurushi_enabled: enabled === true,
    ombaKifurushiEnabled: enabled === true,
    disabled_message_sw: OMBA_KIFURUSHI_DISABLED_MESSAGE_SW,
    synced_at: new Date().toISOString(),
  })
}
