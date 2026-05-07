import { Router } from 'express'
import { readChannels } from '../store.js'
import { getPool } from '../db/pool.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'

export const realtimeSettingsRouter = Router()

const APP_SETTING_KEYS = {
  whatsappEnabled: 'whatsapp_enabled',
  whatsappUrl: 'whatsapp_url',
  popupMode: 'popup_mode',
  popupTitle: 'popup_title',
  popupGreeting: 'popup_greeting',
  popupBulletPoints: 'popup_bullet_points',
  popupDisclaimer: 'popup_disclaimer',
}

const POPUP_MODES = new Set(['show_once', 'always_show', 'disabled'])

const DEFAULTS = {
  [APP_SETTING_KEYS.whatsappEnabled]: 'true',
  [APP_SETTING_KEYS.whatsappUrl]: 'https://wa.me/255700000000',
  [APP_SETTING_KEYS.popupMode]: 'show_once',
  [APP_SETTING_KEYS.popupTitle]: 'Osmani TV',
  [APP_SETTING_KEYS.popupGreeting]: 'Karibu Osmani TV!',
  [APP_SETTING_KEYS.popupBulletPoints]: '[]',
  [APP_SETTING_KEYS.popupDisclaimer]: '',
}

const HEALTH_CACHE_TTL_MS = Math.max(5000, Number(process.env.SERVER_HEALTH_CACHE_MS) || 20000)
const HEALTH_PROBE_TIMEOUT_MS = Math.max(1500, Number(process.env.SERVER_HEALTH_PROBE_TIMEOUT_MS) || 4500)
const HEALTH_BACKGROUND_INTERVAL_MS = Math.max(
  10000,
  Number(process.env.SERVER_HEALTH_BROADCAST_INTERVAL_MS) || 30000,
)

let healthCache = {
  cachedAt: 0,
  payload: null,
  probePromise: null,
}

function asBool(v) {
  const s = String(v ?? '')
    .trim()
    .toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

function asText(v, max = 4000) {
  return String(v ?? '')
    .trim()
    .slice(0, max)
}

function parseBulletPoints(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((x) => asText(x, 300))
      .filter(Boolean)
      .slice(0, 24)
  }
  const text = asText(raw, 12_000)
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((x) => asText(x, 300))
      .filter(Boolean)
      .slice(0, 24)
  } catch {
    return []
  }
}

function normalizePopupMode(v) {
  const s = asText(v, 40).toLowerCase()
  if (s === 'once') return 'show_once'
  if (s === 'always') return 'always_show'
  if (POPUP_MODES.has(s)) return s
  return 'show_once'
}

function normalizeWhatsAppUrl(value) {
  const raw = asText(value, 4000)
  if (!raw) return { ok: false, error: 'url is required' }
  try {
    const url = new URL(raw)
    const host = String(url.hostname || '').toLowerCase()
    if (url.protocol !== 'https:') {
      return { ok: false, error: 'URL must use https' }
    }
    if (host === 'wa.me' || host.endsWith('.wa.me') || host === 'api.whatsapp.com') {
      return { ok: true, value: url.toString() }
    }
    return { ok: false, error: 'Only wa.me or api.whatsapp.com is allowed' }
  } catch {
    return { ok: false, error: 'Invalid URL' }
  }
}

async function ensureAppSettingsTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  for (const [key, value] of Object.entries(DEFAULTS)) {
    await pool.query(
      `INSERT INTO app_settings (key, value)
       VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING`,
      [key, value],
    )
  }
}

async function loadSettings(pool, keys) {
  await ensureAppSettingsTable(pool)
  const { rows } = await pool.query(
    `SELECT key, value
     FROM app_settings
     WHERE key = ANY($1::text[])`,
    [keys],
  )
  const out = {}
  for (const row of rows) {
    out[String(row.key)] = String(row.value ?? '')
  }
  for (const key of keys) {
    if (!(key in out)) out[key] = DEFAULTS[key] ?? ''
  }
  return out
}

async function saveSettings(pool, values) {
  await ensureAppSettingsTable(pool)
  const keys = Object.keys(values)
  for (const key of keys) {
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value,
         updated_at = now()`,
      [key, String(values[key] ?? '')],
    )
  }
}

async function loadWhatsAppSettings(pool) {
  const values = await loadSettings(pool, [APP_SETTING_KEYS.whatsappEnabled, APP_SETTING_KEYS.whatsappUrl])
  return {
    enabled: asBool(values[APP_SETTING_KEYS.whatsappEnabled]),
    url: asText(values[APP_SETTING_KEYS.whatsappUrl], 4000),
  }
}

async function saveWhatsAppSettings(pool, body) {
  const enabled = Boolean(body.enabled)
  const normalized = normalizeWhatsAppUrl(body.url)
  if (!normalized.ok) {
    return { ok: false, status: 400, error: normalized.error }
  }
  const next = { enabled, url: normalized.value }
  console.info('[WHATSAPP_SAVE]', JSON.stringify(next))
  await saveSettings(pool, {
    [APP_SETTING_KEYS.whatsappEnabled]: String(enabled),
    [APP_SETTING_KEYS.whatsappUrl]: normalized.value,
  })
  publishWithLog('whatsapp_settings_changed', next)
  return { ok: true, payload: next }
}

async function loadPopupSettings(pool) {
  const values = await loadSettings(pool, [
    APP_SETTING_KEYS.popupMode,
    APP_SETTING_KEYS.popupTitle,
    APP_SETTING_KEYS.popupGreeting,
    APP_SETTING_KEYS.popupBulletPoints,
    APP_SETTING_KEYS.popupDisclaimer,
  ])
  return {
    mode: normalizePopupMode(values[APP_SETTING_KEYS.popupMode]),
    title: asText(values[APP_SETTING_KEYS.popupTitle], 200),
    greeting: asText(values[APP_SETTING_KEYS.popupGreeting], 500),
    bullet_points: parseBulletPoints(values[APP_SETTING_KEYS.popupBulletPoints]),
    disclaimer: asText(values[APP_SETTING_KEYS.popupDisclaimer], 2000),
  }
}

async function savePopupSettings(pool, body) {
  const payload = {
    mode: normalizePopupMode(body.mode),
    title: asText(body.title, 200),
    greeting: asText(body.greeting, 500),
    bullet_points: parseBulletPoints(body.bullet_points),
    disclaimer: asText(body.disclaimer, 2000),
  }
  if (!payload.title) return { ok: false, status: 400, error: 'title is required' }
  console.info('[POPUP_SAVE]', JSON.stringify(payload))
  await saveSettings(pool, {
    [APP_SETTING_KEYS.popupMode]: payload.mode,
    [APP_SETTING_KEYS.popupTitle]: payload.title,
    [APP_SETTING_KEYS.popupGreeting]: payload.greeting,
    [APP_SETTING_KEYS.popupBulletPoints]: JSON.stringify(payload.bullet_points),
    [APP_SETTING_KEYS.popupDisclaimer]: payload.disclaimer,
  })
  publishWithLog('popup_settings_changed', payload)
  return { ok: true, payload }
}

function getPrimaryStreamUrl(channel) {
  const options = [channel?.url, channel?.backupStream1, channel?.backupStream2]
  for (const candidate of options) {
    const value = asText(candidate, 4000)
    if (!value) continue
    try {
      const u = new URL(value)
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString()
    } catch {
      // ignore malformed URL candidates
    }
  }
  return ''
}

async function probeSingleChannel(channel) {
  const streamUrl = getPrimaryStreamUrl(channel)
  if (!streamUrl) {
    return {
      name: asText(channel?.name, 300) || `Channel ${channel?.id ?? ''}`.trim(),
      status: 'offline',
      response_ms: 0,
      error: 'Missing stream URL',
    }
  }
  const name = asText(channel?.name, 300) || streamUrl
  const start = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort('timeout'), HEALTH_PROBE_TIMEOUT_MS)
  try {
    let res = await fetch(streamUrl, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'osmani-admin-health/1.0' },
    })
    if (res.status === 405 || res.status === 501) {
      res = await fetch(streamUrl, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          Range: 'bytes=0-0',
          'User-Agent': 'osmani-admin-health/1.0',
        },
      })
    }
    const ms = Date.now() - start
    if (res.ok) {
      return { name, status: 'online', response_ms: ms }
    }
    return {
      name,
      status: 'offline',
      response_ms: ms,
      error: `HTTP ${res.status}`,
    }
  } catch (e) {
    const msg = e?.name === 'AbortError' ? 'Timeout' : String(e?.message || e)
    return {
      name,
      status: 'offline',
      response_ms: Date.now() - start,
      error: msg,
    }
  } finally {
    clearTimeout(timer)
  }
}

async function computeServerHealthPayload() {
  const channels = await readChannels()
  const rows = await Promise.all((Array.isArray(channels) ? channels : []).map(probeSingleChannel))
  const onlineChannels = rows.filter((x) => x.status === 'online').length
  const payload = {
    total_channels: rows.length,
    online_channels: onlineChannels,
    offline_channels: rows.length - onlineChannels,
    channels: rows.map((row) => ({
      name: row.name,
      status: row.status,
      ...(row.response_ms > 0 ? { response_ms: row.response_ms } : {}),
      ...(row.error ? { error: row.error } : {}),
    })),
    server_time: new Date().toISOString(),
  }
  console.info(
    '[SERVER_HEALTH]',
    JSON.stringify({
      total_channels: payload.total_channels,
      online_channels: payload.online_channels,
      offline_channels: payload.offline_channels,
    }),
  )
  return payload
}

async function getServerHealthCached(force = false) {
  const fresh = Date.now() - healthCache.cachedAt < HEALTH_CACHE_TTL_MS
  if (!force && fresh && healthCache.payload) return healthCache.payload
  if (healthCache.probePromise) return healthCache.probePromise
  healthCache.probePromise = computeServerHealthPayload()
    .then((payload) => {
      healthCache.payload = payload
      healthCache.cachedAt = Date.now()
      return payload
    })
    .finally(() => {
      healthCache.probePromise = null
    })
  return healthCache.probePromise
}

function publishWithLog(eventName, payload) {
  console.info('[SSE_BROADCAST]', JSON.stringify({ event: eventName, payload }))
  liveSyncBus.publish(eventName, { topics: ['config'], ...payload })
}

realtimeSettingsRouter.get('/whatsapp-settings', async (_req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    const body = await loadWhatsAppSettings(pool)
    return res.json(body)
  } catch (e) {
    console.error('[whatsapp-settings] GET', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

realtimeSettingsRouter.put('/whatsapp-settings', async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const result = await saveWhatsAppSettings(pool, body)
    if (!result.ok) return res.status(result.status).json({ error: result.error })
    return res.json(result.payload)
  } catch (e) {
    console.error('[whatsapp-settings] PUT', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

realtimeSettingsRouter.get('/settings/whatsapp', async (req, res) => {
  const send = (payload) =>
    res.json({
      link: payload.url,
      message: '',
      enabled: payload.enabled,
      url: payload.url,
    })
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    return send(await loadWhatsAppSettings(pool))
  } catch (e) {
    console.error('[settings/whatsapp] GET', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

realtimeSettingsRouter.put('/settings/whatsapp', async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const result = await saveWhatsAppSettings(pool, {
      enabled: body.enabled == null ? true : body.enabled,
      url: body.url ?? body.link ?? '',
    })
    if (!result.ok) return res.status(result.status).json({ error: result.error })
    return res.json({
      link: result.payload.url,
      message: '',
      enabled: result.payload.enabled,
      url: result.payload.url,
    })
  } catch (e) {
    console.error('[settings/whatsapp] PUT', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

realtimeSettingsRouter.get('/popup-settings', async (_req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    const payload = await loadPopupSettings(pool)
    return res.json(payload)
  } catch (e) {
    console.error('[popup-settings] GET', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

realtimeSettingsRouter.put('/popup-settings', async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const result = await savePopupSettings(pool, body)
    if (!result.ok) return res.status(result.status).json({ error: result.error })
    return res.json(result.payload)
  } catch (e) {
    console.error('[popup-settings] PUT', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

realtimeSettingsRouter.get('/settings/popup', async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    const loaded = await loadPopupSettings(pool)
    const mode = loaded.mode
    const payload = {
      mode,
      title: loaded.title,
      greeting: loaded.greeting,
      introduction: '',
      bullets: loaded.bullet_points,
      disclaimer: loaded.disclaimer,
      bullet_points: loaded.bullet_points,
    }
    if (mode === 'show_once') payload.mode = 'once'
    if (mode === 'always_show') payload.mode = 'always'
    return res.json(payload)
  } catch (e) {
    console.error('[settings/popup] GET', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

realtimeSettingsRouter.put('/settings/popup', async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const result = await savePopupSettings(pool, {
      mode: normalizePopupMode(body.mode),
      title: body.title,
      greeting: body.greeting,
      bullet_points: body.bullet_points ?? body.bullets ?? [],
      disclaimer: body.disclaimer,
    })
    if (!result.ok) return res.status(result.status).json({ error: result.error })
    const payload = {
      mode: result.payload.mode,
      title: result.payload.title,
      greeting: result.payload.greeting,
      introduction: '',
      bullets: result.payload.bullet_points,
      disclaimer: result.payload.disclaimer,
      bullet_points: result.payload.bullet_points,
    }
    if (payload.mode === 'show_once') payload.mode = 'once'
    if (payload.mode === 'always_show') payload.mode = 'always'
    return res.json(payload)
  } catch (e) {
    console.error('[settings/popup] PUT', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

realtimeSettingsRouter.get('/server-health', async (_req, res) => {
  try {
    const payload = await getServerHealthCached()
    return res.json(payload)
  } catch (e) {
    console.error('[server-health] GET', e)
    return res.status(500).json({
      total_channels: 0,
      online_channels: 0,
      offline_channels: 0,
      channels: [],
      error: String(e.message || e),
    })
  }
})

setInterval(() => {
  void getServerHealthCached(true)
    .then((payload) => {
      publishWithLog('server_health_changed', payload)
    })
    .catch((e) => {
      console.error('[SERVER_HEALTH] background refresh failed:', e)
    })
}, HEALTH_BACKGROUND_INTERVAL_MS)
