import { getPool } from '../db/pool.js'
import { poolQuery } from './dbQuery.js'

/** Single-row JSON in shared `app_settings` so all Render instances agree on runtime modes. */
export const GLOBAL_APP_MODES_DB_KEY = 'global_app_modes'

let _modesCache = null
let _modesCacheAt = 0
const MODES_CACHE_MS = Math.max(
  500,
  Math.min(60_000, Number(process.env.GLOBAL_MODES_CACHE_MS) || 2000),
)

export function invalidateGlobalModesCache() {
  _modesCache = null
  _modesCacheAt = 0
}

function safeParseModesJson(raw) {
  try {
    const v = JSON.parse(String(raw ?? 'null'))
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

/**
 * @param {(o: object) => object} normalize
 * @returns {Promise<object | null>}
 */
export async function readGlobalModesFromDatabase(normalize) {
  const now = Date.now()
  if (_modesCache && now - _modesCacheAt < MODES_CACHE_MS) {
    return normalize(_modesCache)
  }
  const pool = getPool()
  if (!pool) return null
  try {
    const { rows } = await poolQuery(
      `SELECT value FROM app_settings WHERE key = $1 LIMIT 1`,
      [GLOBAL_APP_MODES_DB_KEY],
      { label: 'global_app_modes' },
    )
    const raw = rows[0]?.value
    if (raw == null || String(raw).trim() === '') return null
    const parsed = safeParseModesJson(raw)
    if (!parsed) return null
    _modesCache = parsed
    _modesCacheAt = now
    return normalize(parsed)
  } catch (e) {
    console.error('[global-app-modes] read DB failed:', e)
    if (_modesCache) return normalize(_modesCache)
    return null
  }
}

/**
 * @param {object} normalized { freeMode, emergencyMode, maintenanceMode }
 */
export async function writeGlobalModesToDatabase(normalized) {
  const pool = getPool()
  if (!pool) return
  const payload = JSON.stringify({
    freeMode: normalized.freeMode === true,
    emergencyMode: normalized.emergencyMode === true,
    maintenanceMode: normalized.maintenanceMode === true,
  })
  await poolQuery(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [GLOBAL_APP_MODES_DB_KEY, payload],
    { label: 'global_app_modes_write' },
  )
  invalidateGlobalModesCache()
  _modesCache = {
    freeMode: normalized.freeMode === true,
    emergencyMode: normalized.emergencyMode === true,
    maintenanceMode: normalized.maintenanceMode === true,
  }
  _modesCacheAt = Date.now()
}
