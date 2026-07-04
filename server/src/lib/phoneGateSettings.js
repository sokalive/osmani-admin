import { getPool } from '../db/pool.js'
import { liveSyncBus } from './liveSyncBus.js'

export const PHONE_GATE_SETTING_KEY = 'phone_gate_enabled'

let _cache = null
let _cacheAt = 0
const CACHE_MS = Math.max(500, Math.min(60_000, Number(process.env.PHONE_GATE_CACHE_MS) || 1500))

export function invalidatePhoneGateCache() {
  _cache = null
  _cacheAt = 0
}

function parseEnabled(raw) {
  const v = String(raw ?? '').trim().toLowerCase()
  if (v === 'false' || v === '0' || v === 'off' || v === 'disabled') return false
  return true
}

/**
 * @param {import('pg').Pool | import('pg').PoolClient} [pool]
 */
export async function readPhoneGateEnabled(pool = null) {
  const now = Date.now()
  if (!pool && _cache != null && now - _cacheAt < CACHE_MS) return _cache

  const p = pool || getPool()
  if (!p) return true

  const { rows } = await p.query(
    `SELECT value FROM app_settings WHERE key = $1 LIMIT 1`,
    [PHONE_GATE_SETTING_KEY],
  )
  const enabled = rows[0] ? parseEnabled(rows[0].value) : true
  if (!pool) {
    _cache = enabled
    _cacheAt = now
  }
  return enabled
}

/**
 * @param {import('pg').Pool | import('pg').PoolClient} pool
 * @param {boolean} enabled
 */
export async function writePhoneGateEnabled(pool, enabled) {
  const value = enabled ? 'true' : 'false'
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [PHONE_GATE_SETTING_KEY, value],
  )
  invalidatePhoneGateCache()
  _cache = enabled === true
  _cacheAt = Date.now()
}

export async function loadPhoneGatePublicPayload() {
  const enabled = await readPhoneGateEnabled()
  const snap = liveSyncBus.snapshot()
  return {
    ok: true,
    v: snap.configVersion,
    phone_gate_enabled: enabled,
    phoneGateEnabled: enabled,
    server_time_ms: Date.now(),
  }
}

export function publishPhoneGateChanged(enabled) {
  liveSyncBus.publish('phone_gate_changed', {
    topics: ['config'],
    phone_gate_enabled: enabled === true,
    phoneGateEnabled: enabled === true,
    synced_at: new Date().toISOString(),
  })
}
