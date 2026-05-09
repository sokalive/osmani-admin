import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { Router } from 'express'
import { bannerToPublicResponse, bannerToResponse } from '../bannerNormalize.js'
import { computeAutomationForAll, WEEKDAY_MASK_ALL } from '../bannerScheduleEngine.js'
import * as bannerStore from '../bannerStore.js'
import { getChannelById } from '../store.js'
import { UPLOADS_DIR, uploadBannerImage } from '../multerUpload.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'

export const bannersRouter = Router()

const upload = uploadBannerImage.single('image')

function runUpload(req, res, next) {
  upload(req, res, (err) => {
    if (err) {
      res.status(400).json({ error: String(err.message || err) })
      return
    }
    next()
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

function parseWeekdayMask(b) {
  const raw = b.weekday_mask ?? b.weekdayMask
  if (raw === undefined || raw === null || raw === '') return WEEKDAY_MASK_ALL
  if (Array.isArray(raw)) {
    let m = 0
    for (const d of raw) {
      const x = Number(d)
      if (Number.isFinite(x) && x >= 0 && x <= 6) m |= 1 << x
    }
    return m === 0 ? WEEKDAY_MASK_ALL : m
  }
  const n = Number.parseInt(String(raw), 10)
  if (!Number.isFinite(n)) return WEEKDAY_MASK_ALL
  return Math.min(127, Math.max(0, Math.floor(n)))
}

function dailyClockMinutesFromPg(v) {
  if (v == null || v === '') return null
  const s = String(v).trim().slice(0, 5)
  const m = /^(\d{1,2}):(\d{2})$/.exec(s)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null
  return h * 60 + min
}

function parseMaybeTimestamptz(v) {
  if (v === undefined || v === null || v === '') return null
  const s = String(v).trim()
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

function manageRowResponse(row, req) {
  if (!row) return null
  const now = new Date()
  const m = computeAutomationForAll([row], now)
  return bannerToResponse(row, req, m.get(Number(row.id)), now)
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
  const useTimer = parseBool(b.event_timer ?? b.eventTimer ?? b.useTimer, false)
  const daily_start = useTimer ? parseTimeToPg(b.daily_start ?? b.dailyStart ?? b.startTime) : null
  const daily_end = useTimer ? parseTimeToPg(b.daily_end ?? b.dailyEnd ?? b.endTime) : null
  const weekday_mask = parseWeekdayMask(b)
  const badge_priority = Number.parseInt(String(b.badge_priority ?? b.badgePriority ?? 0), 10)
  return {
    title: String(b.title ?? '').trim(),
    description: String(b.description ?? '').trim(),
    active: parseBool(b.active ?? b.isActive, true),
    enabled: parseBool(b.enabled ?? b.isEnabled, true),
    badge_automation: parseBool(b.badge_automation ?? b.badgeAutomation, true),
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
    weekday_mask,
    daily_start,
    daily_end,
  }
}

function validateBannerFields(fields) {
  const errors = []
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
    } else {
      const ds = dailyClockMinutesFromPg(fields.daily_start)
      const de = dailyClockMinutesFromPg(fields.daily_end)
      if (ds != null && de != null && ds === de) {
        errors.push('daily start and end times must be different')
      }
    }
    const wm = Number(fields.weekday_mask)
    if (!Number.isFinite(wm) || wm <= 0 || (wm & 127) === 0) {
      errors.push('select at least one weekday when daily repeat is enabled')
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
    const fname = `${Date.now()}-${randomBytes(8).toString('hex')}.${ext}`
    await fs.writeFile(path.join(UPLOADS_DIR, fname), Buffer.from(m[2], 'base64'))
    return `/uploads/${fname}`
  }
  if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('/uploads')) return s
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
bannersRouter.get('/', async (req, res) => {
  try {
    const rows = await bannerStore.listBannersPublic()
    const now = new Date()
    const auto = computeAutomationForAll(rows, now)
    res.json(rows.map((r) => bannerToPublicResponse(r, req, auto.get(Number(r.id)), now)))
  } catch (e) {
    console.error('[banners] GET / failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

/** CMS: all banners (admin UI) */
bannersRouter.get('/manage', async (req, res) => {
  try {
    const rows = await bannerStore.listBannersManage()
    const now = new Date()
    const auto = computeAutomationForAll(rows, now)
    res.json(rows.map((r) => bannerToResponse(r, req, auto.get(Number(r.id)), now)))
  } catch (e) {
    console.error('[banners] GET /manage failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

bannersRouter.post('/', maybeUploadBanner, async (req, res) => {
  try {
    const fields = parseBannerFields(req)
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
      ...fields,
      image: imagePath,
    })
    const full = await bannerStore.getBannerById(inserted.id)
    liveSyncBus.publish('config.banners_changed', {
      topics: ['config'],
      action: 'created',
      bannerId: inserted.id,
    })
    res.status(201).json(manageRowResponse(full, req))
  } catch (e) {
    console.error('[banners] POST / failed:', e)
    if (req.file) await unlinkUploadIfAny(`/uploads/${req.file.filename}`)
    res.status(500).json({ error: String(e.message || e) })
  }
})

bannersRouter.put('/:id', maybeUploadBanner, async (req, res) => {
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

    const fields = parseBannerFields(req)
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

    if (req.file && existing.image?.startsWith('/uploads/')) {
      const oldBase = uploadsBasename(existing.image)
      const newBase = uploadsBasename(imagePath)
      if (oldBase && newBase && oldBase !== newBase) {
        await unlinkUploadIfAny(existing.image)
      }
    }

    const updated = await bannerStore.updateBanner(id, {
      ...fields,
      image: imagePath,
    })
    if (!updated) {
      if (req.file) await unlinkUploadIfAny(`/uploads/${req.file.filename}`)
      return res.status(404).json({ error: 'Banner not found' })
    }
    const full = await bannerStore.getBannerById(id)
    liveSyncBus.publish('config.banners_changed', {
      topics: ['config'],
      action: 'updated',
      bannerId: id,
    })
    res.json(manageRowResponse(full, req))
  } catch (e) {
    console.error('[banners] PUT /:id failed:', e)
    if (req.file) await unlinkUploadIfAny(`/uploads/${req.file.filename}`)
    res.status(500).json({ error: String(e.message || e) })
  }
})

bannersRouter.delete('/:id', async (req, res) => {
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
    liveSyncBus.publish('config.banners_changed', {
      topics: ['config'],
      action: 'deleted',
      bannerId: id,
    })
    res.status(204).send()
  } catch (e) {
    console.error('[banners] DELETE /:id failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})
