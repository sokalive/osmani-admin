import crypto from 'node:crypto'
import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'

export const appUpdateRouter = Router()

const UPDATE_KEYS = {
  soft: 'update_soft',
  force: 'update_force',
  autoDownload: 'update_auto_download',
  source: 'update_source',
  apkUrl: 'update_apk_url',
  apkHash: 'update_apk_hash',
  playstoreUrl: 'update_playstore_url',
}

const DEFAULTS = {
  [UPDATE_KEYS.soft]: 'false',
  [UPDATE_KEYS.force]: 'false',
  [UPDATE_KEYS.autoDownload]: 'false',
  [UPDATE_KEYS.source]: 'inapp',
  [UPDATE_KEYS.apkUrl]: '',
  [UPDATE_KEYS.apkHash]: '',
  [UPDATE_KEYS.playstoreUrl]: '',
}

const VERIFY_MAX_APK_BYTES = Math.max(
  5 * 1024 * 1024,
  Number(process.env.APP_UPDATE_MAX_APK_BYTES) || 300 * 1024 * 1024,
)

function asBool(v) {
  const s = String(v ?? '')
    .trim()
    .toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

function normalizeSource(v) {
  const s = String(v ?? '')
    .trim()
    .toLowerCase()
  if (s === 'play') return 'play'
  if (s === 'apk' || s === 'inapp') return 'apk'
  return 'apk'
}

function text(v, max = 4096) {
  return String(v ?? '')
    .trim()
    .slice(0, max)
}

function normalizeHash(v) {
  return text(v, 128).toLowerCase()
}

function normalizeUiSource(v) {
  return normalizeSource(v) === 'play' ? 'play' : 'inapp'
}

function pickFirstNonEmpty(...values) {
  for (const v of values) {
    const t = text(v, 4000)
    if (t) return t
  }
  return ''
}

function isValidSha256(v) {
  return /^[a-f0-9]{64}$/i.test(String(v || ''))
}

function logDecisionContext(tag, ctx) {
  console.info(`[app-update] ${tag}:`, JSON.stringify(ctx))
}

function toPublicConfig(rowsByKey, tag = 'decision') {
  const source = normalizeSource(rowsByKey[UPDATE_KEYS.source] ?? DEFAULTS[UPDATE_KEYS.source])
  const soft = asBool(rowsByKey[UPDATE_KEYS.soft] ?? DEFAULTS[UPDATE_KEYS.soft])
  const force = asBool(rowsByKey[UPDATE_KEYS.force] ?? DEFAULTS[UPDATE_KEYS.force])
  const autoDownload = asBool(
    rowsByKey[UPDATE_KEYS.autoDownload] ?? DEFAULTS[UPDATE_KEYS.autoDownload],
  )
  const apkUrlRaw = text(rowsByKey[UPDATE_KEYS.apkUrl] ?? DEFAULTS[UPDATE_KEYS.apkUrl], 4000)
  const apkSha256Raw = normalizeHash(rowsByKey[UPDATE_KEYS.apkHash] ?? DEFAULTS[UPDATE_KEYS.apkHash])
  const playstoreUrlRaw = text(rowsByKey[UPDATE_KEYS.playstoreUrl] ?? DEFAULTS[UPDATE_KEYS.playstoreUrl], 4000)
  const hasAnyUrl = Boolean(apkUrlRaw || playstoreUrlRaw)
  const apkUrl =
    source === 'apk' ? pickFirstNonEmpty(apkUrlRaw, playstoreUrlRaw) : text(apkUrlRaw, 4000)
  const playstoreUrl =
    source === 'play' ? pickFirstNonEmpty(playstoreUrlRaw, apkUrlRaw) : text(playstoreUrlRaw, 4000)
  const apkSha256 = isValidSha256(apkSha256Raw) ? apkSha256Raw : ''
  if (apkSha256Raw && !apkSha256) {
    console.warn('[app-update] rejected hash format during decision generation')
  }

  let decision = 'NONE'
  if (force) {
    decision = 'FORCE'
  } else if (soft) {
    decision = 'SOFT'
  }
  const fallbackNotice =
    decision === 'FORCE' && !hasAnyUrl
      ? 'Update source not configured'
      : decision === 'SOFT' && !hasAnyUrl
        ? 'Update available'
        : ''

  logDecisionContext(tag, {
    source,
    soft,
    force,
    decision,
    hasAnyUrl,
    fallbackActivated: Boolean(fallbackNotice),
  })

  return {
    decision,
    source,
    apk_url: apkUrl,
    apk_sha256: apkSha256,
    playstore_url: playstoreUrl,
    auto_download: autoDownload,
    server_time: new Date().toISOString(),
    notice: fallbackNotice,
    // admin view compatibility fields
    softUpdate: soft,
    forceUpdate: force,
    autoDownload,
    apkUrl,
    sha256: apkSha256,
    playstoreUrl,
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
  const rows = Object.entries(DEFAULTS)
  for (const [key, value] of rows) {
    await pool.query(
      `INSERT INTO app_settings (key, value)
       VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING`,
      [key, value],
    )
  }
}

async function loadRowsByKey(pool) {
  await ensureAppSettingsTable(pool)
  const { rows } = await pool.query(
    `SELECT key, value
     FROM app_settings
     WHERE key = ANY($1::text[])`,
    [Object.values(UPDATE_KEYS)],
  )
  const byKey = {}
  for (const row of rows) byKey[String(row.key)] = String(row.value ?? '')
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (!(k in byKey)) byKey[k] = v
  }
  return byKey
}

function requireAdminToken(req, res, next) {
  const expected =
    String(process.env.APP_UPDATE_ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '').trim()
  if (!expected) {
    return res.status(503).json({ ok: false, error: 'APP_UPDATE_ADMIN_TOKEN is not configured' })
  }
  const bearer = String(req.headers.authorization || '')
    .replace(/^bearer\s+/i, '')
    .trim()
  const header = String(req.headers['x-admin-token'] || '').trim()
  const provided = bearer || header
  if (!provided || provided !== expected) {
    return res.status(403).json({ ok: false, error: 'admin token required' })
  }
  return next()
}

function validateHttpsUrl(value) {
  const u = text(value, 4000)
  if (!u) return { ok: true, value: '' }
  try {
    const parsed = new URL(u)
    if (parsed.protocol !== 'https:') {
      return { ok: false, error: 'URL must use https' }
    }
    return { ok: true, value: parsed.toString() }
  } catch {
    return { ok: false, error: 'Invalid URL' }
  }
}

appUpdateRouter.get('/settings/app-update', async (_req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    const data = toPublicConfig(await loadRowsByKey(pool), 'settings:get')
    return res.json({
      softUpdate: data.softUpdate,
      forceUpdate: data.forceUpdate,
      autoDownload: data.autoDownload,
      source: normalizeUiSource(data.source),
      apkUrl: data.apkUrl,
      sha256: data.sha256,
      playstoreUrl: data.playstoreUrl,
    })
  } catch (e) {
    console.error('[settings/app-update] GET', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

appUpdateRouter.put('/settings/app-update', async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const normalizedSource = normalizeSource(body.source)
    const rawApkUrl = text(body.apkUrl, 4000)
    const rawPlaystoreUrl = text(body.playstoreUrl, 4000)
    const rawHash = normalizeHash(body.sha256)
    const apkCheck = validateHttpsUrl(rawApkUrl)
    const playCheck = validateHttpsUrl(rawPlaystoreUrl)
    if (!apkCheck.ok && rawApkUrl) {
      console.warn('[app-update] rejected URL (apk_url):', rawApkUrl)
    }
    if (!playCheck.ok && rawPlaystoreUrl) {
      console.warn('[app-update] rejected URL (playstore_url):', rawPlaystoreUrl)
    }
    if (rawHash && !isValidSha256(rawHash)) {
      console.warn('[app-update] rejected hash (invalid sha256 length/format)')
    }
    const next = {
      [UPDATE_KEYS.soft]: String(Boolean(body.softUpdate)),
      [UPDATE_KEYS.force]: String(Boolean(body.forceUpdate)),
      [UPDATE_KEYS.autoDownload]: String(Boolean(body.autoDownload)),
      [UPDATE_KEYS.source]: normalizedSource,
      [UPDATE_KEYS.apkUrl]: apkCheck.ok ? apkCheck.value : '',
      [UPDATE_KEYS.apkHash]: isValidSha256(rawHash) ? rawHash : '',
      [UPDATE_KEYS.playstoreUrl]: playCheck.ok ? playCheck.value : '',
    }

    await ensureAppSettingsTable(pool)
    for (const [key, value] of Object.entries(next)) {
      await pool.query(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, value],
      )
    }

    const decisionData = toPublicConfig(next, 'settings:put')
    liveSyncBus.publish('config.app_update_changed', {
      topics: ['config'],
      action: 'updated',
      updateDecision: decisionData.decision,
    })

    return res.json({
      softUpdate: asBool(next[UPDATE_KEYS.soft]),
      forceUpdate: asBool(next[UPDATE_KEYS.force]),
      autoDownload: asBool(next[UPDATE_KEYS.autoDownload]),
      source: normalizeUiSource(next[UPDATE_KEYS.source]),
      apkUrl: next[UPDATE_KEYS.apkUrl],
      sha256: next[UPDATE_KEYS.apkHash],
      playstoreUrl: next[UPDATE_KEYS.playstoreUrl],
    })
  } catch (e) {
    console.error('[settings/app-update] PUT', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

appUpdateRouter.get('/update-check', async (_req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    const data = toPublicConfig(await loadRowsByKey(pool), 'update-check:get')
    return res.json({
      decision: data.decision,
      source: data.source,
      apk_url: data.apk_url,
      apk_sha256: data.apk_sha256,
      playstore_url: data.playstore_url,
      auto_download: data.auto_download,
      server_time: data.server_time,
      notice: data.notice,
    })
  } catch (e) {
    console.error('[update-check] GET', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

appUpdateRouter.post('/update-check', async (_req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    const data = toPublicConfig(await loadRowsByKey(pool), 'update-check:post')
    return res.json({
      decision: data.decision,
      source: data.source,
      apk_url: data.apk_url,
      apk_sha256: data.apk_sha256,
      playstore_url: data.playstore_url,
      auto_download: data.auto_download,
      server_time: data.server_time,
      notice: data.notice,
    })
  } catch (e) {
    console.error('[update-check] POST', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

appUpdateRouter.post('/verify-apk-hash', requireAdminToken, async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ ok: false, error: 'Database not configured' })
    const rowsByKey = await loadRowsByKey(pool)
    const selectedUrl = text(req.body?.apk_url ?? req.body?.apkUrl ?? rowsByKey[UPDATE_KEYS.apkUrl], 4000)
    const expectedHash = normalizeHash(
      req.body?.apk_sha256 ?? req.body?.sha256 ?? rowsByKey[UPDATE_KEYS.apkHash],
    )
    const urlCheck = validateHttpsUrl(selectedUrl)
    if (!urlCheck.ok || !urlCheck.value) {
      return res.status(400).json({ ok: false, error: `apk_url: ${urlCheck.error || 'required'}` })
    }
    if (!/^[a-f0-9]{64}$/i.test(expectedHash)) {
      return res.status(400).json({ ok: false, error: 'apk_sha256 must be a 64-character hex hash' })
    }

    const response = await fetch(urlCheck.value)
    if (!response.ok || !response.body) {
      return res.status(400).json({
        ok: false,
        error: `Could not download APK (${response.status})`,
      })
    }
    const contentLength = Number(response.headers.get('content-length') || '0')
    if (Number.isFinite(contentLength) && contentLength > VERIFY_MAX_APK_BYTES) {
      return res.status(413).json({
        ok: false,
        error: `APK exceeds max size limit (${VERIFY_MAX_APK_BYTES} bytes)`,
      })
    }

    const hash = crypto.createHash('sha256')
    const reader = response.body.getReader()
    let totalBytes = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > VERIFY_MAX_APK_BYTES) {
        return res.status(413).json({
          ok: false,
          error: `APK exceeds max size limit (${VERIFY_MAX_APK_BYTES} bytes)`,
        })
      }
      hash.update(value)
    }
    const actual = hash.digest('hex')
    const matches = actual === expectedHash
    return res.json({
      ok: true,
      matches,
      source_url: urlCheck.value,
      expected_sha256: expectedHash,
      actual_sha256: actual,
      size_bytes: totalBytes,
      max_size_bytes: VERIFY_MAX_APK_BYTES,
      server_time: new Date().toISOString(),
    })
  } catch (e) {
    console.error('[verify-apk-hash]', e)
    return res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})
