import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import {
  applyAppUpdateClientDecision,
  applyChannelPlaybackGate,
  clientVersionFromRequest,
  enrichAppUpdateClientFields,
  resolveAppUpdateDecision,
} from '../lib/appUpdateTargeting.js'
import { getPool, getPoolStats } from '../db/pool.js'
import { poolQuery } from '../lib/dbQuery.js'
import { isBunnyCdnHost, resolveHostedApkDownloadUrl } from '../lib/cdnAssets.js'
import { parseApkMetadata } from '../lib/apkMetadata.js'
import { APK_UPLOADS_DIR, uploadApkFile } from '../lib/apkUploadMulter.js'
import { fetchPlayStoreMetadata, parsePlayStorePackageId } from '../lib/playStoreMetadata.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { recordSystemNotificationEvent } from '../lib/runtimeNotifications.js'
import { requireAdminPanelAccess } from '../middleware/adminPanelAuthGate.js'
import { validateApkUploadVersionCode } from '../lib/appUpdateUploadValidation.js'

export const appUpdateRouter = Router()

const UPDATE_KEYS = {
  soft: 'update_soft',
  force: 'update_force',
  autoDownload: 'update_auto_download',
  source: 'update_source',
  apkUrl: 'update_apk_url',
  apkHash: 'update_apk_hash',
  playstoreUrl: 'update_playstore_url',
  title: 'update_title',
  message: 'update_message',
  versionCode: 'update_version_code',
  versionName: 'update_version_name',
  packageName: 'update_package_name',
  requireBeforeChannel: 'update_require_before_channel',
}

const DEFAULTS = {
  [UPDATE_KEYS.soft]: 'false',
  [UPDATE_KEYS.force]: 'false',
  [UPDATE_KEYS.autoDownload]: 'false',
  [UPDATE_KEYS.source]: 'inapp',
  [UPDATE_KEYS.apkUrl]: '',
  [UPDATE_KEYS.apkHash]: '',
  [UPDATE_KEYS.playstoreUrl]: '',
  [UPDATE_KEYS.title]: '',
  [UPDATE_KEYS.message]: '',
  [UPDATE_KEYS.versionCode]: '0',
  [UPDATE_KEYS.versionName]: '',
  [UPDATE_KEYS.packageName]: '',
  [UPDATE_KEYS.requireBeforeChannel]: 'false',
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

function toPublicConfig(rowsByKey, tag = 'decision', req = null) {
  const source = normalizeSource(rowsByKey[UPDATE_KEYS.source] ?? DEFAULTS[UPDATE_KEYS.source])
  const soft = asBool(rowsByKey[UPDATE_KEYS.soft] ?? DEFAULTS[UPDATE_KEYS.soft])
  const force = asBool(rowsByKey[UPDATE_KEYS.force] ?? DEFAULTS[UPDATE_KEYS.force])
  const autoDownload = asBool(
    rowsByKey[UPDATE_KEYS.autoDownload] ?? DEFAULTS[UPDATE_KEYS.autoDownload],
  )
  const apkUrlRaw = text(rowsByKey[UPDATE_KEYS.apkUrl] ?? DEFAULTS[UPDATE_KEYS.apkUrl], 4000)
  const apkSha256Raw = normalizeHash(rowsByKey[UPDATE_KEYS.apkHash] ?? DEFAULTS[UPDATE_KEYS.apkHash])
  const playstoreUrlRaw = text(rowsByKey[UPDATE_KEYS.playstoreUrl] ?? DEFAULTS[UPDATE_KEYS.playstoreUrl], 4000)
  const updateTitle = text(rowsByKey[UPDATE_KEYS.title] ?? DEFAULTS[UPDATE_KEYS.title], 256)
  const updateMessage = text(rowsByKey[UPDATE_KEYS.message] ?? DEFAULTS[UPDATE_KEYS.message], 4000)
  const versionCode = parseVersionCode(rowsByKey[UPDATE_KEYS.versionCode] ?? DEFAULTS[UPDATE_KEYS.versionCode])
  const versionName = text(rowsByKey[UPDATE_KEYS.versionName] ?? DEFAULTS[UPDATE_KEYS.versionName], 64)
  const packageName = text(rowsByKey[UPDATE_KEYS.packageName] ?? DEFAULTS[UPDATE_KEYS.packageName], 256)
  const requireUpdateBeforeChannelPlayback = asBool(
    rowsByKey[UPDATE_KEYS.requireBeforeChannel] ?? DEFAULTS[UPDATE_KEYS.requireBeforeChannel],
  )
  const hasAnyUrl = Boolean(apkUrlRaw || playstoreUrlRaw)
  const apkUrl = resolveHostedApkDownloadUrl(
    source === 'apk' ? pickFirstNonEmpty(apkUrlRaw, playstoreUrlRaw) : text(apkUrlRaw, 4000),
    req,
  )
  const playstoreUrl =
    source === 'play' ? pickFirstNonEmpty(playstoreUrlRaw, apkUrlRaw) : text(playstoreUrlRaw, 4000)
  const apkSha256 = isValidSha256(apkSha256Raw) ? apkSha256Raw : ''
  if (apkSha256Raw && !apkSha256) {
    console.warn('[app-update] rejected hash format during decision generation')
  }

  let decision = resolveAppUpdateDecision({
    soft,
    force,
    autoDownload,
    versionCode,
    hasAnyUrl,
  })
  const fallbackNotice =
    decision === 'FORCE' && !hasAnyUrl
      ? 'Update source not configured'
      : decision === 'SOFT' && !hasAnyUrl
        ? 'Update available'
        : ''
  const composedNotice = pickFirstNonEmpty(
    updateMessage,
    updateTitle && updateMessage ? `${updateTitle}: ${updateMessage}` : updateTitle,
    fallbackNotice,
  )

  logDecisionContext(tag, {
    source,
    soft,
    force,
    autoDownload,
    decision,
    hasAnyUrl,
    fallbackActivated: Boolean(fallbackNotice),
  })

  return enrichAppUpdateClientFields({
    decision,
    source,
    apk_url: apkUrl,
    apk_sha256: apkSha256,
    playstore_url: playstoreUrl,
    auto_download: autoDownload,
    server_time: new Date().toISOString(),
    notice: composedNotice,
    update_title: updateTitle,
    update_message: updateMessage,
    version_code: versionCode,
    version_name: versionName,
    package_name: packageName,
    // admin view compatibility fields
    softUpdate: soft,
    forceUpdate: force,
    autoDownload,
    apkUrl,
    sha256: apkSha256,
    playstoreUrl,
    updateTitle,
    updateMessage,
    versionCode,
    versionName,
    packageName,
    requireUpdateBeforeChannelPlayback,
  })
}

/** Public OTA payload (same fields as GET /update-check) for runtime + SSE. */
export function appUpdateToOtaPayload(data, configVersion = 0) {
  const d = enrichAppUpdateClientFields(data && typeof data === 'object' ? data : {})
  return {
    ok: true,
    v: Number(configVersion) || 0,
    decision: String(d.decision ?? 'NONE').toUpperCase(),
    source: normalizeSource(d.source),
    apk_url: resolveHostedApkDownloadUrl(text(d.apk_url ?? d.apkUrl, 4000)),
    apk_sha256: isValidSha256(d.apk_sha256 ?? d.sha256) ? normalizeHash(d.apk_sha256 ?? d.sha256) : '',
    playstore_url: text(d.playstore_url ?? d.playstoreUrl, 4000),
    auto_download: d.auto_download === true || d.autoDownload === true,
    cancelable: d.cancelable === true,
    dismissible: d.dismissible === true,
    force_update: d.force_update === true,
    soft_update: d.soft_update === true,
    update_mode: String(d.update_mode ?? d.decision ?? 'none').toLowerCase(),
    force: d.force === true,
    server_time: String(d.server_time ?? new Date().toISOString()),
    notice: text(d.notice, 4000),
    update_title: text(d.update_title ?? d.updateTitle, 256),
    update_message: text(d.update_message ?? d.updateMessage, 4000),
    version_code: parseVersionCode(d.version_code ?? d.versionCode),
    version_name: text(d.version_name ?? d.versionName, 64),
    package_name: text(d.package_name ?? d.packageName, 256),
    ...(d.update_target_reason
      ? { update_target_reason: String(d.update_target_reason) }
      : {}),
    require_update_before_channel_playback: d.require_update_before_channel_playback === true,
    channel_playback_block_title: text(d.channel_playback_block_title, 256),
    channel_playback_block_message: text(d.channel_playback_block_message, 4000),
  }
}

export async function loadAppUpdatePublicPayload(configVersion, clientVersionCode = 0) {
  const pool = getPool()
  if (!pool) {
    const data = applyAppUpdateClientDecision(
      toPublicConfig({ ...DEFAULTS }, 'no-db'),
      clientVersionCode,
    )
    return appUpdateToOtaPayload(data, configVersion)
  }
  let data
  try {
    data = toPublicConfig(await loadRowsByKey(pool), 'runtime')
  } catch (e) {
    console.error('[app-update] loadAppUpdatePublicPayload fallback', e?.message || e)
    data = toPublicConfig({ ...DEFAULTS, ...(_appSettingsCache || {}) }, 'runtime-stale')
  }
  if (clientVersionCode > 0) {
    data = applyAppUpdateClientDecision(data, clientVersionCode)
    data = applyChannelPlaybackGate(data, clientVersionCode)
  } else {
    data = {
      ...data,
      decision: 'NONE',
      update_target_reason: 'no_client_version',
      require_update_before_channel_playback: false,
      channel_playback_block_title: '',
      channel_playback_block_message: '',
    }
  }
  return appUpdateToOtaPayload(data, configVersion)
}

function publishAppUpdateChanged(action, decisionData, extra = {}) {
  invalidateAppSettingsCache()
  const snap = liveSyncBus.snapshot()
  const app_update = appUpdateToOtaPayload(decisionData, snap.configVersion)
  liveSyncBus.publish('config.app_update_changed', {
    topics: ['config'],
    action,
    app_update,
    updateDecision: decisionData.decision,
    synced_at: new Date().toISOString(),
    ...extra,
  })
  return app_update
}

let _appSettingsTableReady = false

async function ensureAppSettingsTableOnce(pool) {
  if (_appSettingsTableReady) return
  await poolQuery(
    `CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );`,
    [],
    { label: 'app_settings_ddl', timeoutMs: 15_000 },
  )
  const rows = Object.entries(DEFAULTS)
  for (const [key, value] of rows) {
    await poolQuery(
      `INSERT INTO app_settings (key, value)
       VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING`,
      [key, value],
      { label: 'app_settings_seed' },
    )
  }
  _appSettingsTableReady = true
}

async function loadRowsByKey(pool) {
  const now = Date.now()
  if (_appSettingsCache && now - _appSettingsCacheAt < APP_SETTINGS_CACHE_MS) {
    return _appSettingsCache
  }
  try {
    await ensureAppSettingsTableOnce(pool)
    const { rows } = await poolQuery(
      `SELECT key, value
       FROM app_settings
       WHERE key = ANY($1::text[])`,
      [Object.values(UPDATE_KEYS)],
      { label: 'app_settings_read' },
    )
    const byKey = {}
    for (const row of rows) byKey[String(row.key)] = String(row.value ?? '')
    for (const [k, v] of Object.entries(DEFAULTS)) {
      if (!(k in byKey)) byKey[k] = v
    }
    _appSettingsCache = byKey
    _appSettingsCacheAt = now
    return byKey
  } catch (e) {
    if (_appSettingsCache) {
      console.warn('[app-update] DB read failed — serving stale app_settings cache', {
        error: String(e?.message || e),
        pool: getPoolStats(),
      })
      return _appSettingsCache
    }
    throw e
  }
}

let _appSettingsCache = null
let _appSettingsCacheAt = 0
const APP_SETTINGS_CACHE_MS = Math.max(
  2000,
  Math.min(120_000, Number(process.env.APP_SETTINGS_CACHE_MS) || 30_000),
)

export function invalidateAppSettingsCache() {
  _appSettingsCache = null
  _appSettingsCacheAt = 0
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

/** Hosted APK URLs may use http on localhost; external URLs still require https. */
function validateApkUrl(value) {
  const u = text(value, 4000)
  if (!u) return { ok: true, value: '' }
  try {
    const parsed = new URL(u)
    if (parsed.pathname.includes('/uploads/apks/')) {
      if (
        parsed.protocol === 'https:' ||
        parsed.protocol === 'http:' ||
        isBunnyCdnHost(parsed.hostname)
      ) {
        return { ok: true, value: parsed.toString() }
      }
      return { ok: false, error: 'Invalid hosted APK URL' }
    }
    return validateHttpsUrl(u)
  } catch {
    return { ok: false, error: 'Invalid URL' }
  }
}

function parseVersionCode(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.trunc(n)
}

/** @deprecated — use applyAppUpdateClientDecision from lib/appUpdateTargeting.js */
function applyClientVersionDecision(data, clientVersionInput) {
  return applyAppUpdateClientDecision(data, clientVersionInput)
}

function hostedApkPublicUrl(req, filename) {
  const name = path.basename(String(filename ?? ''))
  if (!name) return ''
  return resolveHostedApkDownloadUrl(`/uploads/apks/${name}`, req)
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return hash.digest('hex')
}

async function upsertSetting(pool, key, value) {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  )
}

async function writeSettingsMap(pool, map) {
  await ensureAppSettingsTableOnce(pool)
  for (const [key, value] of Object.entries(map)) {
    await upsertSetting(pool, key, value)
  }
}

appUpdateRouter.get('/settings/app-update', requireAdminPanelAccess, async (_req, res) => {
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
      updateTitle: data.updateTitle,
      updateMessage: data.updateMessage,
      versionCode: data.versionCode,
      versionName: data.versionName,
      packageName: data.packageName,
      requireUpdateBeforeChannelPlayback: data.requireUpdateBeforeChannelPlayback,
    })
  } catch (e) {
    console.error('[settings/app-update] GET', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

appUpdateRouter.put('/settings/app-update', requireAdminPanelAccess, async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    console.info('[app-update] save payload:', JSON.stringify(body))
    const normalizedSource = normalizeSource(body.source)
    const rawApkUrl = text(body.apkUrl, 4000)
    const rawPlaystoreUrl = text(body.playstoreUrl, 4000)
    const rawHash = normalizeHash(body.sha256)
    const rowsBefore = await loadRowsByKey(pool)
    const storedVersionCode = parseVersionCode(rowsBefore[UPDATE_KEYS.versionCode])
    const incomingVersionCode = parseVersionCode(body.versionCode)
    if (incomingVersionCode > 0 && incomingVersionCode < storedVersionCode) {
      return res.status(400).json({
        error: `versionCode must not be less than current (${storedVersionCode})`,
      })
    }

    const apkCheck = validateApkUrl(rawApkUrl)
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
      [UPDATE_KEYS.apkUrl]: apkCheck.ok ? resolveHostedApkDownloadUrl(apkCheck.value, req) || apkCheck.value : '',
      [UPDATE_KEYS.apkHash]: isValidSha256(rawHash) ? rawHash : '',
      [UPDATE_KEYS.playstoreUrl]: playCheck.ok ? playCheck.value : '',
      [UPDATE_KEYS.title]: text(body.updateTitle ?? body.title, 256),
      [UPDATE_KEYS.message]: text(body.updateMessage ?? body.message, 4000),
      [UPDATE_KEYS.versionCode]: String(
        incomingVersionCode > 0 ? incomingVersionCode : storedVersionCode,
      ),
      [UPDATE_KEYS.versionName]: text(body.versionName, 64),
      [UPDATE_KEYS.packageName]: text(body.packageName, 256),
      [UPDATE_KEYS.requireBeforeChannel]: String(
        body.requireUpdateBeforeChannelPlayback !== undefined
          ? Boolean(body.requireUpdateBeforeChannelPlayback)
          : asBool(
              rowsBefore[UPDATE_KEYS.requireBeforeChannel] ??
                DEFAULTS[UPDATE_KEYS.requireBeforeChannel],
            ),
      ),
    }

    await ensureAppSettingsTableOnce(pool)
    let writes = 0
    for (const [key, value] of Object.entries(next)) {
      const result = await pool.query(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, value],
      )
      writes += Number(result.rowCount) || 0
    }
    console.info('[app-update] db write result:', JSON.stringify({ keys: Object.keys(next), writes }))

    const decisionData = toPublicConfig(next, 'settings:put')
    publishAppUpdateChanged('updated', decisionData)
    void recordSystemNotificationEvent('config.app_update_changed', {
      updateDecision: decisionData.decision,
      source: decisionData.source,
    }).catch((err) => {
      console.error('[app-update] notification sync failed:', err)
    })
    console.info(
      '[app-update] emitted SSE event:',
      JSON.stringify({
        event: 'config.app_update_changed',
        updateDecision: decisionData.decision,
        source: decisionData.source,
      }),
    )

    const stored = toPublicConfig(await loadRowsByKey(pool), 'settings:stored-after-save')
    console.info(
      '[app-update] stored values after save:',
      JSON.stringify({
        softUpdate: stored.softUpdate,
        forceUpdate: stored.forceUpdate,
        autoDownload: stored.autoDownload,
        source: stored.source,
        apkUrl: stored.apkUrl,
        sha256: stored.sha256,
        playstoreUrl: stored.playstoreUrl,
        decision: stored.decision,
        requireUpdateBeforeChannelPlayback: stored.requireUpdateBeforeChannelPlayback,
      }),
    )

    return res.json({
      softUpdate: stored.softUpdate,
      forceUpdate: stored.forceUpdate,
      autoDownload: stored.autoDownload,
      source: normalizeUiSource(stored.source),
      apkUrl: stored.apkUrl,
      sha256: stored.sha256,
      playstoreUrl: stored.playstoreUrl,
      updateTitle: stored.updateTitle,
      updateMessage: stored.updateMessage,
      versionCode: stored.versionCode,
      versionName: stored.versionName,
      packageName: stored.packageName,
      requireUpdateBeforeChannelPlayback: stored.requireUpdateBeforeChannelPlayback,
    })
  } catch (e) {
    console.error('[settings/app-update] PUT', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

appUpdateRouter.post('/settings/app-update/upload-apk', requireAdminPanelAccess, (req, res) => {
  uploadApkFile.single('apk')(req, res, (multerErr) => {
    void (async () => {
      if (multerErr) {
        const msg =
          multerErr.code === 'LIMIT_FILE_SIZE'
            ? 'APK file is too large'
            : String(multerErr.message || multerErr)
        return res.status(400).json({ ok: false, error: msg })
      }
      const pool = getPool()
      if (!pool) return res.status(503).json({ ok: false, error: 'Database not configured' })
      if (!req.file?.path) {
        return res.status(400).json({ ok: false, error: 'apk file is required' })
      }

      let stagedPath = req.file.path
      try {
        const meta = await parseApkMetadata(stagedPath)
        if (!meta) {
          return res.status(400).json({
            ok: false,
            error: 'Could not read APK metadata (package, versionCode, versionName)',
          })
        }

        const rowsBefore = await loadRowsByKey(pool)
        const currentCode = parseVersionCode(rowsBefore[UPDATE_KEYS.versionCode])
        const versionCheck = validateApkUploadVersionCode(meta, currentCode)
        if (!versionCheck.ok) {
          return res.status(400).json({
            ok: false,
            error: versionCheck.error,
            currentVersionCode: versionCheck.currentVersionCode,
            uploadedVersionCode: versionCheck.uploadedVersionCode,
          })
        }
        if (versionCheck.reupload) {
          console.info('[app-update] same-version APK re-upload allowed', {
            versionCode: versionCheck.uploadedVersionCode,
            packageName: meta.packageName,
          })
        }

        const safeName = String(meta.versionName || meta.versionCode)
          .replace(/[^\w.\-]+/g, '_')
          .slice(0, 48)
        const finalFilename = `osmani-v${meta.versionCode}-${safeName}.apk`
        const finalPath = path.join(APK_UPLOADS_DIR, finalFilename)
        if (fs.existsSync(finalPath)) {
          fs.unlinkSync(finalPath)
        }
        fs.renameSync(stagedPath, finalPath)
        stagedPath = finalPath

        const sha256 = await sha256File(finalPath)
        const apkUrl = hostedApkPublicUrl(req, finalFilename)
        if (!apkUrl) {
          return res.status(500).json({
            ok: false,
            error: 'Could not build public APK URL (set BASE_URL and/or BUNNY_CDN_BASE_URL on the server)',
          })
        }

        const prevTitle = text(rowsBefore[UPDATE_KEYS.title])
        const prevMessage = text(rowsBefore[UPDATE_KEYS.message])
        const autoTitle = prevTitle || `Update v${meta.versionName}`
        const autoMessage =
          prevMessage ||
          `A new version (${meta.versionName}) is available. Please update to continue.`

        const next = {
          ...rowsBefore,
          [UPDATE_KEYS.apkUrl]: apkUrl,
          [UPDATE_KEYS.apkHash]: sha256,
          [UPDATE_KEYS.versionCode]: String(meta.versionCode),
          [UPDATE_KEYS.versionName]: meta.versionName,
          [UPDATE_KEYS.packageName]: meta.packageName,
          [UPDATE_KEYS.source]: 'apk',
          [UPDATE_KEYS.title]: autoTitle,
          [UPDATE_KEYS.message]: autoMessage,
        }
        await writeSettingsMap(pool, {
          [UPDATE_KEYS.apkUrl]: apkUrl,
          [UPDATE_KEYS.apkHash]: sha256,
          [UPDATE_KEYS.versionCode]: String(meta.versionCode),
          [UPDATE_KEYS.versionName]: meta.versionName,
          [UPDATE_KEYS.packageName]: meta.packageName,
          [UPDATE_KEYS.source]: 'apk',
          [UPDATE_KEYS.title]: autoTitle,
          [UPDATE_KEYS.message]: autoMessage,
        })

        const decisionData = toPublicConfig(next, 'upload-apk')
        publishAppUpdateChanged('apk_uploaded', decisionData, { versionCode: meta.versionCode })

        const stored = toPublicConfig(await loadRowsByKey(pool), 'upload-apk:stored')
        return res.json({
          ok: true,
          apkUrl: stored.apkUrl,
          sha256: stored.sha256,
          versionCode: meta.versionCode,
          versionName: meta.versionName,
          packageName: meta.packageName,
          filename: finalFilename,
          sizeBytes: fs.statSync(finalPath).size,
          softUpdate: stored.softUpdate,
          forceUpdate: stored.forceUpdate,
          autoDownload: stored.autoDownload,
          source: normalizeUiSource(stored.source),
          playstoreUrl: stored.playstoreUrl,
          updateTitle: stored.updateTitle,
          updateMessage: stored.updateMessage,
          saved: true,
        })
      } catch (e) {
        console.error('[settings/app-update/upload-apk]', e)
        return res.status(500).json({ ok: false, error: String(e.message || e) })
      } finally {
        if (stagedPath && fs.existsSync(stagedPath) && stagedPath.includes('upload-')) {
          try {
            fs.unlinkSync(stagedPath)
          } catch {
            /* ignore cleanup */
          }
        }
      }
    })()
  })
})

appUpdateRouter.post('/settings/app-update/parse-playstore', requireAdminPanelAccess, async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ ok: false, error: 'Database not configured' })

    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const rawUrl = text(body.url ?? body.playstoreUrl ?? body.playStoreUrl, 4000)
    const persist = body.persist !== false

    const packageId = parsePlayStorePackageId(rawUrl)
    if (!packageId) {
      return res.status(400).json({ ok: false, error: 'Invalid Google Play Store URL or package id' })
    }

    const meta = await fetchPlayStoreMetadata(rawUrl)
    const playstoreUrl = meta.playstoreUrl
    const playCheck = validateHttpsUrl(playstoreUrl)
    if (!playCheck.ok) {
      return res.status(400).json({ ok: false, error: playCheck.error || 'Invalid Play Store URL' })
    }

    const rowsBefore = await loadRowsByKey(pool)
    const prevTitle = text(rowsBefore[UPDATE_KEYS.title])
    const updateTitle = meta.title || prevTitle
    const updateMessage = text(rowsBefore[UPDATE_KEYS.message])

    if (persist) {
      await writeSettingsMap(pool, {
        [UPDATE_KEYS.playstoreUrl]: playCheck.value,
        [UPDATE_KEYS.versionName]: text(meta.versionName, 64),
        [UPDATE_KEYS.packageName]: text(meta.packageId, 256),
        [UPDATE_KEYS.title]: text(updateTitle, 256),
        [UPDATE_KEYS.message]: updateMessage,
        [UPDATE_KEYS.source]: 'play',
      })

      const next = {
        ...rowsBefore,
        [UPDATE_KEYS.playstoreUrl]: playCheck.value,
        [UPDATE_KEYS.versionName]: text(meta.versionName, 64),
        [UPDATE_KEYS.packageName]: text(meta.packageId, 256),
        [UPDATE_KEYS.title]: text(updateTitle, 256),
        [UPDATE_KEYS.source]: 'play',
      }
      const decisionData = toPublicConfig(next, 'parse-playstore')
      publishAppUpdateChanged('playstore_parsed', decisionData)
    }

    const stored = persist ? toPublicConfig(await loadRowsByKey(pool), 'parse-playstore:stored') : null
    const storedVersionCode = parseVersionCode(rowsBefore[UPDATE_KEYS.versionCode])

    return res.json({
      ok: true,
      packageId: meta.packageId,
      packageName: meta.packageId,
      title: meta.title,
      versionName: meta.versionName,
      versionCode: persist ? stored?.versionCode ?? storedVersionCode : storedVersionCode,
      playstoreUrl: playCheck.value,
      persisted: persist,
      updateTitle: persist ? stored?.updateTitle : updateTitle,
      updateMessage: persist ? stored?.updateMessage : updateMessage,
      source: persist ? normalizeUiSource(stored?.source) : 'play',
      versionCodeNote:
        'Google Play listings do not expose Android versionCode — set it manually or upload an APK.',
    })
  } catch (e) {
    console.error('[settings/app-update/parse-playstore]', e)
    return res.status(400).json({ ok: false, error: String(e.message || e) })
  }
})

function updateCheckJsonFromOta(ota) {
  const o = ota && typeof ota === 'object' ? ota : {}
  return {
    decision: o.decision,
    source: o.source,
    apk_url: o.apk_url,
    apk_sha256: o.apk_sha256,
    playstore_url: o.playstore_url,
    auto_download: o.auto_download,
    cancelable: o.cancelable,
    dismissible: o.dismissible,
    force_update: o.force_update,
    soft_update: o.soft_update,
    update_mode: o.update_mode,
    force: o.force,
    server_time: o.server_time,
    notice: o.notice,
    update_title: o.update_title,
    update_message: o.update_message,
    version_code: o.version_code,
    version_name: o.version_name,
    package_name: o.package_name,
    ...(o.update_target_reason ? { update_target_reason: o.update_target_reason } : {}),
    require_update_before_channel_playback: o.require_update_before_channel_playback === true,
    channel_playback_block_title: o.channel_playback_block_title || '',
    channel_playback_block_message: o.channel_playback_block_message || '',
  }
}

async function buildUpdateCheckResponse(req) {
  const clientCode = clientVersionFromRequest(req)
  const snap = liveSyncBus.snapshot()
  const ota = await loadAppUpdatePublicPayload(snap.configVersion, clientCode)
  return updateCheckJsonFromOta(ota)
}

appUpdateRouter.get('/update-check', async (req, res) => {
  try {
    if (!getPool()) return res.status(503).json({ error: 'Database not configured' })
    return res.json(await buildUpdateCheckResponse(req))
  } catch (e) {
    console.error('[update-check] GET', e)
    const clientCode = clientVersionFromRequest(req)
    const stale = applyChannelPlaybackGate(
      applyAppUpdateClientDecision(
        toPublicConfig({ ...DEFAULTS }, 'update-check:stale'),
        clientCode,
      ),
      clientCode,
    )
    return res.json(updateCheckJsonFromOta(appUpdateToOtaPayload(stale, 0)))
  }
})

appUpdateRouter.post('/update-check', async (req, res) => {
  try {
    if (!getPool()) return res.status(503).json({ error: 'Database not configured' })
    return res.json(await buildUpdateCheckResponse(req))
  } catch (e) {
    console.error('[update-check] POST', e)
    const clientCode = clientVersionFromRequest(req)
    const stale = applyChannelPlaybackGate(
      applyAppUpdateClientDecision(
        toPublicConfig({ ...DEFAULTS }, 'update-check:stale'),
        clientCode,
      ),
      clientCode,
    )
    return res.json(updateCheckJsonFromOta(appUpdateToOtaPayload(stale, 0)))
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
