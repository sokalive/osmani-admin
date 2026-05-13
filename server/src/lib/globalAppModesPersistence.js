import { getPool } from '../db/pool.js'

/** Single-row JSON in shared `app_settings` so all Render instances agree on runtime modes. */
export const GLOBAL_APP_MODES_DB_KEY = 'global_app_modes'

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
  const pool = getPool()
  if (!pool) return null
  try {
    const { rows } = await pool.query(
      `SELECT value FROM app_settings WHERE key = $1 LIMIT 1`,
      [GLOBAL_APP_MODES_DB_KEY],
    )
    const raw = rows[0]?.value
    if (raw == null || String(raw).trim() === '') return null
    const parsed = safeParseModesJson(raw)
    if (!parsed) return null
    return normalize(parsed)
  } catch (e) {
    console.error('[global-app-modes] read DB failed:', e)
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
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [GLOBAL_APP_MODES_DB_KEY, payload],
  )
}
