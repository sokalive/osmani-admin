import { Router } from 'express'
import { readChannels } from '../store.js'
import { getPool } from '../db/pool.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { recordSystemNotificationEvent } from '../lib/runtimeNotifications.js'
import { apiResponseCacheNamespace } from '../middleware/apiResponseCache.js'
import { requireAdminPanelAccess } from '../middleware/adminPanelAuthGate.js'

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
  30_000,
  Number(process.env.SERVER_HEALTH_BROADCAST_INTERVAL_MS) || 60_000,
)

function serverHealthBackgroundEnabled() {
  const raw = String(process.env.SERVER_HEALTH_BACKGROUND_ENABLED ?? '0').trim().toLowerCase()
  return ['1', 'true', 'yes', 'on'].includes(raw)
}
const MEDIA_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) ExoPlayerLib/2.19.1'

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

/** Public read payload for production APK + SSE stream init. */
export async function getWhatsAppSettingsPublicPayload() {
  const pool = getPool()
  if (!pool) return null
  return loadWhatsAppSettings(pool)
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

/** Legacy APK + `/api/settings/popup` contract (`once` / `always` mode aliases). */
function buildPublicPopupPayload(loaded) {
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
  return payload
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
  void recordSystemNotificationEvent('popup_settings_changed', payload).catch((err) => {
    console.error('[popup-settings] notification sync failed:', err)
  })
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

function isLikelyHlsUrl(url) {
  return /\.m3u8($|\?)/i.test(String(url || ''))
}

function isHlsContentType(contentType) {
  const ct = String(contentType || '').toLowerCase()
  return ct.includes('application/vnd.apple.mpegurl') || ct.includes('application/x-mpegurl')
}

function isPotentiallyOnlineStatus(status) {
  return status === 200 || status === 206 || status === 301 || status === 302
}

function buildProbeHeaders(channel, extra = {}) {
  const referer = asText(channel?.referer, 4000)
  const origin = asText(channel?.origin, 4000)
  const ua = asText(channel?.userAgent, 500) || MEDIA_USER_AGENT
  return {
    'User-Agent': ua,
    Accept: '*/*',
    Connection: 'keep-alive',
    ...(referer ? { Referer: referer } : {}),
    ...(origin ? { Origin: origin } : {}),
    ...extra,
  }
}

async function runProbeRequest(
  channel,
  url,
  method,
  { range = null, parseText = false } = {},
) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort('timeout'), HEALTH_PROBE_TIMEOUT_MS)
  const started = Date.now()
  const headers = buildProbeHeaders(channel, range ? { Range: range } : {})
  try {
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      signal: controller.signal,
      headers,
    })
    const ms = Date.now() - started
    const contentType = res.headers.get('content-type') || ''
    let snippet = ''
    if (parseText) {
      try {
        const text = await res.text()
        snippet = String(text || '').slice(0, 4096)
      } catch {
        snippet = ''
      }
    }
    return {
      ok: true,
      status: Number(res.status) || 0,
      ms,
      redirected: Boolean(res.redirected),
      finalUrl: res.url || url,
      contentType,
      snippet,
    }
  } catch (e) {
    return {
      ok: false,
      status: 0,
      ms: Date.now() - started,
      redirected: false,
      finalUrl: url,
      contentType: '',
      snippet: '',
      error: e?.name === 'AbortError' ? 'Timeout' : String(e?.message || e),
    }
  } finally {
    clearTimeout(timer)
  }
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
  const attempted = []
  const hlsByUrl = isLikelyHlsUrl(streamUrl)

  const head = await runProbeRequest(channel, streamUrl, 'HEAD')
  attempted.push({ method: 'HEAD', status: head.status, error: head.error || '' })
  if (head.ok && isPotentiallyOnlineStatus(head.status)) {
    console.info(
      '[SERVER_HEALTH]',
      JSON.stringify({
        channel: name,
        method: 'HEAD',
        decision: 'online',
        status: head.status,
        redirected: head.redirected,
      }),
    )
    return { name, status: 'online', response_ms: head.ms }
  }
  if (!head.ok || head.status === 403 || head.status === 404 || head.status === 405 || head.status === 501) {
    console.info(
      '[SERVER_HEALTH]',
      JSON.stringify({
        channel: name,
        message: 'provider blocked or failed HEAD; using GET range fallback',
        status: head.status,
        error: head.error || '',
      }),
    )
  }

  const ranged = await runProbeRequest(channel, streamUrl, 'GET', { range: 'bytes=0-1' })
  attempted.push({ method: 'GET_RANGE', status: ranged.status, error: ranged.error || '' })
  if (ranged.ok && (ranged.status === 206 || ranged.status === 200 || ranged.status === 301 || ranged.status === 302)) {
    console.info(
      '[SERVER_HEALTH]',
      JSON.stringify({
        channel: name,
        method: 'GET_RANGE',
        decision: 'online',
        status: ranged.status,
        redirected: ranged.redirected,
      }),
    )
    return { name, status: 'online', response_ms: ranged.ms }
  }

  const shouldTryHlsFetch =
    hlsByUrl ||
    isHlsContentType(head.contentType) ||
    isHlsContentType(ranged.contentType) ||
    head.status === 403 ||
    ranged.status === 403

  if (shouldTryHlsFetch) {
    const playlist = await runProbeRequest(channel, streamUrl, 'GET', { parseText: true })
    attempted.push({ method: 'GET_PLAYLIST', status: playlist.status, error: playlist.error || '' })
    const hasManifest =
      isHlsContentType(playlist.contentType) ||
      String(playlist.snippet || '').toUpperCase().includes('#EXTM3U')
    const onlineByPlaylist =
      hasManifest && (playlist.status === 403 || playlist.status === 200 || playlist.status === 206)
    if (playlist.ok && onlineByPlaylist) {
      console.info(
        '[SERVER_HEALTH]',
        JSON.stringify({
          channel: name,
          method: 'GET_PLAYLIST',
          decision: 'online',
          status: playlist.status,
          redirected: playlist.redirected,
          fallback: 'hls_manifest_detected',
        }),
      )
      return { name, status: 'online', response_ms: playlist.ms }
    }
  }

  const fallbackMs = ranged.ms || head.ms || 0
  const statusHint = ranged.status || head.status || 0
  console.info(
    '[SERVER_HEALTH]',
    JSON.stringify({
      channel: name,
      decision: 'offline',
      status: statusHint,
      attempted,
      redirect_followed: Boolean(head.redirected || ranged.redirected),
    }),
  )
  return {
    name,
    status: 'offline',
    response_ms: fallbackMs,
    error: statusHint ? `HTTP ${statusHint}` : (ranged.error || head.error || 'Probe failed'),
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

/**
 * Legacy production APK treats online_channels===0 as "Muunganisho wa Intaneti Unahitajika"
 * even when the API is reachable. Floor to 1 when catalog exists; add camelCase + ok mirrors.
 */
export function toLegacyPublicServerHealthPayload(payload) {
  const body = payload && typeof payload === 'object' ? payload : {}
  const total = Math.max(0, Number(body.total_channels) || 0)
  let online = Math.max(0, Number(body.online_channels) || 0)
  if (total > 0 && online === 0) online = 1
  const offline = Math.max(0, total - online)
  const serverTime =
    typeof body.server_time === 'string' && body.server_time
      ? body.server_time
      : new Date().toISOString()
  return {
    ok: true,
    total_channels: total,
    online_channels: online,
    offline_channels: offline,
    totalChannels: total,
    onlineChannels: online,
    offlineChannels: offline,
    channels: Array.isArray(body.channels) ? body.channels : [],
    server_time: serverTime,
    serverTime,
  }
}

function publishWithLog(eventName, payload) {
  console.info('[SSE_BROADCAST]', JSON.stringify({ event: eventName, payload }))
  liveSyncBus.publish(eventName, {
    topics: ['config'],
    ...payload,
    synced_at: new Date().toISOString(),
  })
}

export async function triggerServerHealthBroadcast(force = true) {
  const payload = await getServerHealthCached(force)
  publishWithLog('server_health_changed', payload)
  return payload
}

/** Aggregated public settings (WhatsApp + popup) for clients that prefer one poll. */
realtimeSettingsRouter.get('/settings/public', apiResponseCacheNamespace('settings-public'), async (_req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    const [whatsapp, popup] = await Promise.all([loadWhatsAppSettings(pool), loadPopupSettings(pool)])
    const mode = popup.mode
    const popupPayload = {
      mode,
      title: popup.title,
      greeting: popup.greeting,
      introduction: '',
      bullets: popup.bullet_points,
      disclaimer: popup.disclaimer,
      bullet_points: popup.bullet_points,
    }
    if (mode === 'show_once') popupPayload.mode = 'once'
    if (mode === 'always_show') popupPayload.mode = 'always'
    return res.json({ whatsapp, popup: popupPayload })
  } catch (e) {
    console.error('[settings/public] GET', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

/** Public read for production APK; admin PUT remains protected. */
realtimeSettingsRouter.get(
  '/whatsapp-settings',
  apiResponseCacheNamespace('whatsapp-settings'),
  async (_req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    const body = await loadWhatsAppSettings(pool)
    return res.json(body)
  } catch (e) {
    console.error('[whatsapp-settings] GET', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
},
)

realtimeSettingsRouter.put('/whatsapp-settings', requireAdminPanelAccess, async (req, res) => {
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

realtimeSettingsRouter.get(
  '/settings/whatsapp',
  apiResponseCacheNamespace('settings-whatsapp'),
  async (req, res) => {
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
},
)

realtimeSettingsRouter.put('/settings/whatsapp', requireAdminPanelAccess, async (req, res) => {
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

/** Public read for legacy production APK; admin PUT remains protected. */
realtimeSettingsRouter.get(
  '/popup-settings',
  apiResponseCacheNamespace('popup-settings'),
  async (_req, res) => {
    try {
      const pool = getPool()
      if (!pool) return res.status(503).json({ error: 'Database not configured' })
      return res.json(buildPublicPopupPayload(await loadPopupSettings(pool)))
    } catch (e) {
      console.error('[popup-settings] GET', e)
      return res.status(500).json({ error: String(e.message || e) })
    }
  },
)

realtimeSettingsRouter.put('/popup-settings', requireAdminPanelAccess, async (req, res) => {
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

realtimeSettingsRouter.get(
  '/settings/popup',
  apiResponseCacheNamespace('settings-popup'),
  async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    return res.json(buildPublicPopupPayload(await loadPopupSettings(pool)))
  } catch (e) {
    console.error('[settings/popup] GET', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
},
)

realtimeSettingsRouter.put('/settings/popup', requireAdminPanelAccess, async (req, res) => {
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

/** Public connectivity + channel probe for legacy production APK; admin UI uses same route with auth. */
realtimeSettingsRouter.get('/server-health', async (_req, res) => {
  try {
    const payload = await getServerHealthCached()
    return res.json(toLegacyPublicServerHealthPayload(payload))
  } catch (e) {
    console.error('[server-health] GET', e)
    try {
      const channels = await readChannels()
      const total = Array.isArray(channels) ? channels.length : 0
      return res.json(
        toLegacyPublicServerHealthPayload({
          total_channels: total,
          online_channels: total > 0 ? 1 : 0,
          offline_channels: total > 0 ? Math.max(0, total - 1) : 0,
          channels: [],
          server_time: new Date().toISOString(),
        }),
      )
    } catch {
      return res.json(
        toLegacyPublicServerHealthPayload({
          total_channels: 1,
          online_channels: 1,
          offline_channels: 0,
          channels: [],
          server_time: new Date().toISOString(),
        }),
      )
    }
  }
})

if (serverHealthBackgroundEnabled()) {
  console.info(
    `[SERVER_HEALTH] background probes enabled (every ${HEALTH_BACKGROUND_INTERVAL_MS}ms)`,
  )
  setInterval(() => {
    void triggerServerHealthBroadcast(true).catch((e) => {
      console.error('[SERVER_HEALTH] background refresh failed:', e)
    })
  }, HEALTH_BACKGROUND_INTERVAL_MS)
} else {
  console.info(
    '[SERVER_HEALTH] background probes disabled — probes run on GET /api/server-health and channel changes only',
  )
}
