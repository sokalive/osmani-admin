import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { ensureJsonFile, readJson, writeJsonAtomic } from '../lib/jsonFile.js'
import {
  readGlobalModesFromDatabase,
  writeGlobalModesToDatabase,
} from '../lib/globalAppModesPersistence.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { recordSystemNotificationEvent } from '../lib/runtimeNotifications.js'
import { requireAdminPanelAccess } from '../middleware/adminPanelAuthGate.js'

export const GLOBAL_APP_SETTINGS_FILE = 'global-app-settings.json'

const defaults = {
  freeMode: false,
  emergencyMode: false,
  maintenanceMode: false,
}

function normalizeSettings(obj) {
  const o = obj && typeof obj === 'object' ? obj : {}
  return {
    freeMode: Boolean(o.freeMode),
    emergencyMode: Boolean(o.emergencyMode),
    maintenanceMode: Boolean(o.maintenanceMode),
  }
}

/**
 * Shared source of truth: PostgreSQL `app_settings.global_app_modes` when DATABASE_URL is set,
 * otherwise JSON file only. Migrates file → DB once when DB row is missing.
 */
export async function loadMergedNormalizedSettings() {
  const fromDb = await readGlobalModesFromDatabase(normalizeSettings)
  if (fromDb) return fromDb
  const fromFile = normalizeSettings(await readJson(GLOBAL_APP_SETTINGS_FILE, defaults))
  if (getPool()) {
    await writeGlobalModesToDatabase(fromFile).catch((e) => {
      console.warn('[settings] migrate global modes to DB skipped:', e?.message || e)
    })
  }
  return fromFile
}

/** Snake_case flags for clients + SSE `app_modes` on subscription-stream. */
export function modesPayloadFromNormalized(n) {
  return {
    free_mode: n.freeMode === true,
    emergency_mode: n.emergencyMode === true,
    maintenance_mode: n.maintenanceMode === true,
  }
}

/** Used by subscription-stream SSE (poll + settings sync). */
export async function loadGlobalAppModesPayload() {
  const n = await loadMergedNormalizedSettings()
  const snap = liveSyncBus.snapshot()
  return {
    ok: true,
    v: snap.configVersion,
    ...modesPayloadFromNormalized(n),
    server_time_ms: Date.now(),
  }
}

export const globalAppSettingsRouter = Router()

/** Public read for legacy production APK (camelCase + snake_case + app_modes). PUT remains admin-only. */
globalAppSettingsRouter.get('/', async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    const data = await loadMergedNormalizedSettings()
    const modes = modesPayloadFromNormalized(data)
    res.json({
      ok: true,
      ...data,
      free_mode: modes.free_mode,
      emergency_mode: modes.emergency_mode,
      maintenance_mode: modes.maintenance_mode,
      app_modes: modes,
      appModes: modes,
    })
  } catch (e) {
    console.error('[settings] GET / failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

globalAppSettingsRouter.put('/', requireAdminPanelAccess, async (req, res) => {
  try {
    const current = await loadMergedNormalizedSettings()
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const next = normalizeSettings({
      ...current,
      ...body,
    })
    if (getPool()) {
      await writeGlobalModesToDatabase(next)
    }
    await writeJsonAtomic(GLOBAL_APP_SETTINGS_FILE, next)
    const modes = modesPayloadFromNormalized(next)
    // SSE paths mirror `app_modes` + legacy `app_settings_changed` for Android (see liveSync + subscription-stream).
    liveSyncBus.publish('config.settings_changed', {
      topics: ['config'],
      action: 'updated',
      modes,
      synced_at: new Date().toISOString(),
    })
    void recordSystemNotificationEvent('config.settings_changed', { modes }).catch((err) => {
      console.error('[settings] notification sync failed:', err)
    })
    res.json(next)
  } catch (e) {
    console.error('[settings] PUT / failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

export async function ensureGlobalAppSettingsFile() {
  await ensureJsonFile(GLOBAL_APP_SETTINGS_FILE, `${JSON.stringify(defaults, null, 2)}\n`)
}
