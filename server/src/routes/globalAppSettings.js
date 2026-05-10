import { Router } from 'express'
import { ensureJsonFile, readJson, writeJsonAtomic } from '../lib/jsonFile.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'

export const GLOBAL_APP_SETTINGS_FILE = 'global-app-settings.json'

const defaults = {
  freeMode: false,
  emergencyMode: false,
  maintenanceMode: false,
  bannerEngine: {
    sseEvent: 'banners_changed',
    defaultRepeatMode: 'none',
    defaultTimezone: 'UTC',
    comingSoonHours: Number(process.env.BANNER_COMING_SOON_HOURS ?? 72) || 72,
  },
}

export function modesPayloadFromNormalized(n) {
  return {
    free_mode: n.freeMode === true,
    emergency_mode: n.emergencyMode === true,
    maintenance_mode: n.maintenanceMode === true,
  }
}

function normalizeSettings(obj) {
  const o = obj && typeof obj === 'object' ? obj : {}
  const beSource =
    (o.bannerEngine && typeof o.bannerEngine === 'object' && o.bannerEngine) ||
    (o.banner_engine && typeof o.banner_engine === 'object' && o.banner_engine) ||
    {}
  const be = beSource
  const comingSoonHoursNum = Number(be.comingSoonHours ?? defaults.bannerEngine.comingSoonHours)
  const bannerEngine = {
    sseEvent: 'banners_changed',
    defaultRepeatMode: String(be.defaultRepeatMode ?? defaults.bannerEngine.defaultRepeatMode).toLowerCase() === 'daily'
      ? 'daily'
      : 'none',
    defaultTimezone: String(be.defaultTimezone ?? defaults.bannerEngine.defaultTimezone).trim() || 'UTC',
    comingSoonHours:
      Number.isFinite(comingSoonHoursNum) && comingSoonHoursNum > 0 ? comingSoonHoursNum : 72,
  }
  return {
    freeMode: Boolean(o.freeMode),
    emergencyMode: Boolean(o.emergencyMode),
    maintenanceMode: Boolean(o.maintenanceMode),
    bannerEngine,
    banner_engine: bannerEngine,
  }
}

/** Light JSON for polling / SSE (subscriber apps). Uses current config SSE version counter. */
export async function loadGlobalAppModesPayload() {
  const n = normalizeSettings(await readJson(GLOBAL_APP_SETTINGS_FILE, defaults))
  const snap = liveSyncBus.snapshot()
  return {
    ok: true,
    v: snap.configVersion,
    ...modesPayloadFromNormalized(n),
    server_time_ms: Date.now(),
  }
}

export const globalAppSettingsRouter = Router()

globalAppSettingsRouter.get('/', async (_req, res) => {
  try {
    const data = await readJson(GLOBAL_APP_SETTINGS_FILE, defaults)
    res.json(normalizeSettings(data))
  } catch (e) {
    console.error('[settings] GET / failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

globalAppSettingsRouter.put('/', async (req, res) => {
  try {
    const current = normalizeSettings(await readJson(GLOBAL_APP_SETTINGS_FILE, defaults))
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const next = normalizeSettings({
      ...current,
      ...body,
    })
    await writeJsonAtomic(GLOBAL_APP_SETTINGS_FILE, next)
    const modes = modesPayloadFromNormalized(next)
    liveSyncBus.publish('config.settings_changed', {
      topics: ['config'],
      action: 'updated',
      modes,
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
