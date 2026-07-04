import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { Router } from 'express'
import { bannerToPublicResponse, bannerToResponse } from '../bannerNormalize.js'
import {
  DEFAULT_RUNTIME_POSITION,
  parseRuntimePositionFromBody,
} from '../lib/bannerRuntimePosition.js'
import { enrichBannersListForViewer } from '../lib/bannerViewerSerializer.js'
import * as bannerStore from '../bannerStore.js'
import { getChannelById } from '../store.js'
import { UPLOADS_DIR, sendUploadError, uploadBannerImage } from '../multerUpload.js'
import { afterImageMulter } from '../lib/imageMulterPipeline.js'
import { persistImageBufferToUploads } from '../lib/uploadDiskSafety.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { invalidateApiCacheNamespace } from '../lib/apiResponseCache.js'
import { apiResponseCacheExact } from '../middleware/apiResponseCache.js'
import { requireAdminPanelAccess } from '../middleware/adminPanelAuthGate.js'

function publishBannersChanged(action, extra = {}) {
  invalidateApiCacheNamespace('banners')
  return liveSyncBus.publish('config.banners_changed', {
    topics: ['config'],
    action,
    synced_at: new Date().toISOString(),
    ...extra,
  })
}

export const bannersRouter = Router()

const upload = uploadBannerImage.single('image')

function runUpload(req, res, next) {
  upload(req, res, (err) => {
    void afterImageMulter(req, res, next, err)
  })
}

function maybeUploadBanner(req, res, next) {
  if (req.is('multipart/form-data')) {
    return runUpload(req, res, next)
  }
  return next()
}

function parseBool(v, defaultVal) {
  if (v === undefined || v === null || v === '') return defaultVal
  if (typeof v === 'boolean') return v
  const s = String(v).toLowerCase()
  if (s === 'true' || s === '1' || s === 'on' || s === 'yes') return true
  if (s === 'false' || s === '0' || s === 'off' || s === 'no') return false
  return defaultVal
}

function parseRedirectChannelId(b) {
  const idRaw = b.redirect_channel_id ?? b.redirectChannelId
  if (idRaw !== undefined && idRaw !== null && idRaw !== '') {
    const n = Number.parseInt(String(idRaw), 10)
    return Number.isNaN(n) ? null : n
  }
  const legacy = b.redirectChannel
  if (legacy === '' || legacy == null) return null
  const s = String(legacy).trim()
  if (/^\d+$/.test(s)) {
    const n = Number.parseInt(s, 10)
    return Number.isNaN(n) ? null : n
  }
  return null
}

/** Normalize HH:mm or HH:mm:ss for PostgreSQL TIME */
function parseTimeToPg(v) {
  if (v == null) return null
  const s = String(v).trim()
  if (!s) return null
  if (/^\d{1,2}:\d{2}$/.test(s)) {
    const [hh, mm] = s.split(':')
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`
  }
  if (/^\d{2}:\d{2}:\d{2}$/.test(s)) return s
  return s
}

function parseMaybeTimestamptz(v) {
  if (v === undefined || v === null || v === '') return null
  const s = String(v).trim()
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

function parseBadgeColor(v) {
  const raw = String(v ?? '#FBBF24').trim()
  if (!raw) return '#FBBF24'
  if (/^#[0-9A-Fa-f]{6}$/.test(raw)) return raw.toUpperCase()
  if (/^#[0-9A-Fa-f]{3}$/.test(raw)) return raw.toUpperCase()
  return '#FBBF24'
}

function parseBannerFields(req) {
  const b = req.body || {}
  const runtimeParsed = parseRuntimePositionFromBody(b)
  const useTimer = parseBool(b.event_timer ?? b.eventTimer ?? b.useTimer, false)
  const daily_start = useTimer ? parseTimeToPg(b.daily_start ?? b.dailyStart ?? b.startTime) : null
  const daily_end = useTimer ? parseTimeToPg(b.daily_end ?? b.dailyEnd ?? b.endTime) : null
  const badge_priority = Number.parseInt(String(b.badge_priority ?? b.badgePriority ?? 0), 10)
  return {
    title: String(b.title ?? '').trim(),
    description: String(b.description ?? '').trim(),
    active: parseBool(b.active ?? b.isActive, true),
    enabled: parseBool(b.enabled ?? b.isEnabled, true),
    badge: String(b.badge ?? '').trim(),
    badge_enabled: parseBool(b.badge_enabled ?? b.badgeEnabled, true),
    badge_color: parseBadgeColor(b.badge_color ?? b.badgeColor),
    badge_blink: parseBool(b.badge_blink ?? b.badgeBlink, false),
    badge_priority: Number.isFinite(badge_priority) ? badge_priority : 0,
    enable_countdown: parseBool(b.enable_countdown ?? b.enableCountdown, false),
    event_start: parseMaybeTimestamptz(b.event_start ?? b.eventStart),
    event_end: parseMaybeTimestamptz(b.event_end ?? b.eventEnd),
    redirect_channel_id: parseRedirectChannelId(b),
    sort_order: Number.parseInt(String(b.sort_order ?? b.sortOrder ?? 0), 10) || 0,
    event_timer: useTimer,
    daily_start,
    daily_end,
    runtime_position: runtimeParsed.error
      ? DEFAULT_RUNTIME_POSITION
      : runtimeParsed.value,
    _runtimePositionError: runtimeParsed.error ?? null,
  }
}

function bannerFieldsForStore(fields) {
  const { _runtimePositionError: _ignored, ...rest } = fields
  return rest
}

function logRuntimePositionDebug(scope, data) {
  if (process.env.BANNER_RUNTIME_POSITION_DEBUG !== '1') return
  console.info(`[banners][runtime_position] ${scope}`, data)
}

function validateBannerFields(fields) {
  const errors = []
  if (fields._runtimePositionError) errors.push(fields._runtimePositionError)
  if (!fields.title) errors.push('title is required')
  if (fields.enable_countdown && !fields.event_start) {
    errors.push('event_start is required when enable_countdown is true')
  }
  if (fields.event_start && fields.event_end) {
    const t0 = fields.event_start.getTime()
    const t1 = fields.event_end.getTime()
    if (t1 <= t0) errors.push('event_end must be after event_start')
  }
  if (fields.event_timer) {
    if (!fields.daily_start || !fields.daily_end) {
      errors.push('daily start and end times are required when event timer is enabled')
    }
  }
  return errors
}

async function validateRedirectChannelExists(redirectChannelId) {
  if (redirectChannelId == null) return null
  const row = await getChannelById(redirectChannelId)
  if (!row) return 'redirect_channel_id does not refer to an existing channel'
  return null
}

async function resolveImagePath({ body, file, existingImage }) {
  if (file) return `/uploads/${file.filename}`
  const raw = body?.image ?? body?.imageUrl
  if (raw == null || raw === '') return existingImage ?? null
  const s = String(raw).trim()
  if (s.startsWith('data:image')) {
    const m = s.match(/^data:image\/(\w+);base64,(.+)$/i)
    if (!m) throw new Error('Invalid image data URL')
    const extRaw = m[1].toLowerCase()
    const ext = extRaw === 'jpeg' ? 'jpg' : extRaw.replace(/[^a-z0-9]/g, '') || 'png'
    const buffer = Buffer.from(m[2], 'base64')
    const persisted = await persistImageBufferToUploads(buffer, {
      filename: `${Date.now()}-${randomBytes(8).toString('hex')}.${ext}`,
    })
    return persisted.relativePath
  }
  if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('/uploads')) {
    if (s.startsWith('/uploads/')) return s
    try {
      const parsed = new URL(s)
      if (parsed.pathname.startsWith('/uploads/')) {
        return parsed.pathname
      }
    } catch {
      // Keep external URLs unchanged.
    }
    return s
  }
  return existingImage ?? null
}

function uploadsBasename(imagePath) {
  if (!imagePath || typeof imagePath !== 'string') return null
  if (!imagePath.startsWith('/uploads/')) return null
  return path.basename(imagePath)
}

async function unlinkUploadIfAny(imagePath) {
  const base = uploadsBasename(imagePath)
  if (!base) return
  await fs.unlink(path.join(UPLOADS_DIR, base)).catch(() => {})
}

/** Public: spec visibility + shape only (DB rows, no demo fallbacks). */
bannersRouter.get('/', apiResponseCacheExact('banners'), async (req, res) => {
  try {
    const rows = await bannerStore.listBannersPublic()
    const payload = enrichBannersListForViewer(
      rows.map((r) => bannerToPublicResponse(r, req)).filter(Boolean),
    )
    res.setHeader('Cache-Control', 'no-store')
    res.json(payload)
  } catch (e) {
    console.error('[banners] GET / failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

/**
 * Temporary debug: compare PostgreSQL runtime_position vs API serializers.
 * GET /api/banners/debug/runtime-position?id=10
 * GET /api/banners/debug/runtime-position?title=Orhan
 */
bannersRouter.get('/debug/runtime-position', requireAdminPanelAccess, async (req, res) => {
  try {
    const idRaw = req.query?.id
    const id =
      idRaw != null && String(idRaw).trim() !== ''
        ? Number.parseInt(String(idRaw), 10)
        : null
    const titlePattern =
      req.query?.title != null && String(req.query.title).trim() !== ''
        ? String(req.query.title).trim()
        : null
    const rows = await bannerStore.queryBannersRuntimePositionDebug({
      id: Number.isFinite(id) ? id : null,
      titlePattern,
    })
    res.setHeader('Cache-Control', 'no-store')
    res.json({
      ok: true,
      queried_at: new Date().toISOString(),
      banners: rows.map((row) => {
        const manage = bannerToResponse(row, req)
        const pub = bannerToPublicResponse(row, req)
        return {
          id: Number(row.id),
          title: row.title ?? '',
          active: Boolean(row.active),
          sort_order: Number(row.sort_order) || 0,
          db_runtime_position: row.runtime_position ?? null,
          api_manage_runtime_position: manage?.runtime_position ?? null,
          api_public_runtime_position: pub?.runtime_position ?? null,
          db_matches_public_api:
            String(row.runtime_position ?? '').trim().toLowerCase() ===
            String(pub?.runtime_position ?? '').trim().toLowerCase(),
        }
      }),
    })
  } catch (e) {
    console.error('[banners] GET /debug/runtime-position failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

/** CMS: all banners (admin UI) */
bannersRouter.get('/manage', requireAdminPanelAccess, async (req, res) => {
  try {
    const rows = await bannerStore.listBannersManage()
    res.json(rows.map((r) => bannerToResponse(r, req)))
  } catch (e) {
    console.error('[banners] GET /manage failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

bannersRouter.post('/reorder', requireAdminPanelAccess, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const orders = Array.isArray(body.orders) ? body.orders : []
    if (orders.length === 0) {
      return res.status(400).json({ error: 'orders array required' })
    }
    const updated = await bannerStore.reorderBanners(orders)
    publishBannersChanged('reordered')
    res.json({ ok: true, updated })
  } catch (e) {
    console.error('[banners] POST /reorder failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

bannersRouter.post('/', requireAdminPanelAccess, maybeUploadBanner, async (req, res) => {
  try {
    logRuntimePositionDebug('POST body', {
      runtime_position: req.body?.runtime_position,
      runtimePosition: req.body?.runtimePosition,
    })
    const fields = parseBannerFields(req)
    logRuntimePositionDebug('POST parsed', { runtime_position: fields.runtime_position })
    const vErrs = validateBannerFields(fields)
    if (vErrs.length) {
      if (req.file) await unlinkUploadIfAny(`/uploads/${req.file.filename}`)
      return res.status(400).json({ error: vErrs.join('; ') })
    }
    const redirErr = await validateRedirectChannelExists(fields.redirect_channel_id)
    if (redirErr) {
      if (req.file) await unlinkUploadIfAny(`/uploads/${req.file.filename}`)
      return res.status(400).json({ error: redirErr })
    }
    let imagePath
    try {
      imagePath = await resolveImagePath({
        body: req.body,
        file: req.file,
        existingImage: null,
      })
    } catch (e) {
      if (req.file) await unlinkUploadIfAny(`/uploads/${req.file.filename}`)
      return res.status(400).json({ error: String(e.message || e) })
    }
    if (!imagePath) {
      if (req.file) await unlinkUploadIfAny(`/uploads/${req.file.filename}`)
      return res.status(400).json({ error: 'image is required (file upload, /uploads path, data URL, or https URL)' })
    }

    const inserted = await bannerStore.insertBanner({
      ...bannerFieldsForStore(fields),
      image: imagePath,
    })
    const full = await bannerStore.getBannerById(inserted.id)
    logRuntimePositionDebug('POST DB row', { id: inserted.id, runtime_position: full?.runtime_position })
    publishBannersChanged('created', { bannerId: inserted.id })
    const responseBody = bannerToResponse(full, req)
    logRuntimePositionDebug('POST API response', {
      id: responseBody?.id,
      runtime_position: responseBody?.runtime_position,
    })
    res.status(201).json(responseBody)
  } catch (e) {
    console.error('[banners] POST / failed:', e)
    if (req.file) await unlinkUploadIfAny(`/uploads/${req.file.filename}`)
    return sendUploadError(res, e, req, { status: 500 })
  }
})

bannersRouter.put('/:id', requireAdminPanelAccess, maybeUploadBanner, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10)
    if (Number.isNaN(id)) {
      if (req.file) await unlinkUploadIfAny(`/uploads/${req.file.filename}`)
      return res.status(400).json({ error: 'Invalid id' })
    }
    const existing = await bannerStore.getBannerById(id)
    if (!existing) {
      if (req.file) await unlinkUploadIfAny(`/uploads/${req.file.filename}`)
      return res.status(404).json({ error: 'Banner not found' })
    }

    logRuntimePositionDebug('PUT body', {
      id,
      runtime_position: req.body?.runtime_position,
      runtimePosition: req.body?.runtimePosition,
    })
    const fields = parseBannerFields(req)
    logRuntimePositionDebug('PUT parsed', { id, runtime_position: fields.runtime_position })
    const vErrs = validateBannerFields(fields)
    if (vErrs.length) {
      if (req.file) await unlinkUploadIfAny(`/uploads/${req.file.filename}`)
      return res.status(400).json({ error: vErrs.join('; ') })
    }
    const redirErr = await validateRedirectChannelExists(fields.redirect_channel_id)
    if (redirErr) {
      if (req.file) await unlinkUploadIfAny(`/uploads/${req.file.filename}`)
      return res.status(400).json({ error: redirErr })
    }

    let imagePath
    try {
      imagePath = await resolveImagePath({
        body: req.body,
        file: req.file,
        existingImage: existing.image,
      })
    } catch (e) {
      if (req.file) await unlinkUploadIfAny(`/uploads/${req.file.filename}`)
      return res.status(400).json({ error: String(e.message || e) })
    }
    if (!imagePath) {
      if (req.file) await unlinkUploadIfAny(`/uploads/${req.file.filename}`)
      return res.status(400).json({ error: 'image is required' })
    }

    const updated = await bannerStore.updateBanner(id, {
      ...bannerFieldsForStore(fields),
      image: imagePath,
    })
    if (!updated) {
      if (req.file) await unlinkUploadIfAny(`/uploads/${req.file.filename}`)
      return res.status(404).json({ error: 'Banner not found' })
    }

    if (req.file && existing.image?.startsWith('/uploads/')) {
      const oldBase = uploadsBasename(existing.image)
      const newBase = uploadsBasename(imagePath)
      if (oldBase && newBase && oldBase !== newBase) {
        await unlinkUploadIfAny(existing.image)
      }
    }

    const full = await bannerStore.getBannerById(id)
    logRuntimePositionDebug('PUT DB row', { id, runtime_position: full?.runtime_position })
    publishBannersChanged('updated', {
      bannerId: id,
      updatedAt: full?.updated_at instanceof Date ? full.updated_at.toISOString() : full?.updated_at ?? null,
    })
    const responseBody = bannerToResponse(full, req)
    logRuntimePositionDebug('PUT API response', {
      id: responseBody?.id,
      runtime_position: responseBody?.runtime_position,
      runtimePosition: responseBody?.runtimePosition,
    })
    if (process.env.BANNER_RUNTIME_POSITION_DEBUG === '1') {
      responseBody._runtime_position_debug = {
        db_runtime_position: full?.runtime_position ?? null,
        parsed_runtime_position: fields.runtime_position,
        api_runtime_position: responseBody.runtime_position,
      }
    }
    res.json(responseBody)
  } catch (e) {
    console.error('[banners] PUT /:id failed:', e)
    if (req.file) await unlinkUploadIfAny(`/uploads/${req.file.filename}`)
    return sendUploadError(res, e, req, { status: 500 })
  }
})

bannersRouter.delete('/:id', requireAdminPanelAccess, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10)
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: 'Invalid id' })
    }
    const existing = await bannerStore.getBannerById(id)
    if (!existing) {
      return res.status(404).json({ error: 'Banner not found' })
    }
    await bannerStore.deleteBannerById(id)
    await unlinkUploadIfAny(existing.image)
    publishBannersChanged('deleted', { bannerId: id })
    res.status(204).send()
  } catch (e) {
    console.error('[banners] DELETE /:id failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})
