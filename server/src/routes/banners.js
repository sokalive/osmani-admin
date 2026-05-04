import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { Router } from 'express'
import { bannerToResponse } from '../bannerNormalize.js'
import * as bannerStore from '../bannerStore.js'
import { UPLOADS_DIR, uploadBannerImage } from '../multerUpload.js'

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
  const raw = b.redirect_channel_id ?? b.redirectChannelId ?? b.redirectChannel
  if (raw === '' || raw == null) return null
  const n = Number.parseInt(String(raw), 10)
  return Number.isNaN(n) ? null : n
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

function parseBannerFields(req) {
  const b = req.body || {}
  const useTimer = parseBool(b.event_timer ?? b.eventTimer ?? b.useTimer, false)
  const daily_start = useTimer ? parseTimeToPg(b.daily_start ?? b.dailyStart ?? b.startTime) : null
  const daily_end = useTimer ? parseTimeToPg(b.daily_end ?? b.dailyEnd ?? b.endTime) : null
  return {
    title: String(b.title ?? '').trim(),
    description: String(b.description ?? '').trim(),
    active: parseBool(b.active ?? b.isActive, true),
    enabled: parseBool(b.enabled ?? b.isEnabled, true),
    badge: String(b.badge ?? '').trim(),
    redirect_channel_id: parseRedirectChannelId(b),
    sort_order: Number.parseInt(String(b.sort_order ?? b.sortOrder ?? 0), 10) || 0,
    event_timer: useTimer,
    daily_start,
    daily_end,
  }
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

/** Public: active + enabled + schedule; sorted by sort_order */
bannersRouter.get('/', async (req, res) => {
  try {
    const rows = await bannerStore.listBannersPublic()
    res.json(rows.map((r) => bannerToResponse(r, req)))
  } catch {
    res.status(500).json({ error: 'Failed to load banners' })
  }
})

/** CMS: all banners (admin UI), sorted by sort_order */
bannersRouter.get('/manage', async (req, res) => {
  try {
    const rows = await bannerStore.listBannersManage()
    res.json(rows.map((r) => bannerToResponse(r, req)))
  } catch {
    res.status(500).json({ error: 'Failed to load banners' })
  }
})

bannersRouter.post('/', maybeUploadBanner, async (req, res) => {
  try {
    const fields = parseBannerFields(req)
    if (!fields.title || !fields.description) {
      if (req.file) await unlinkUploadIfAny(`/uploads/${req.file.filename}`)
      return res.status(400).json({ error: 'title and description are required' })
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
    res.status(201).json(bannerToResponse(full, req))
  } catch {
    if (req.file) await unlinkUploadIfAny(`/uploads/${req.file.filename}`)
    res.status(500).json({ error: 'Failed to create banner' })
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
    if (!fields.title || !fields.description) {
      if (req.file) await unlinkUploadIfAny(`/uploads/${req.file.filename}`)
      return res.status(400).json({ error: 'title and description are required' })
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
    res.json(bannerToResponse(full, req))
  } catch {
    if (req.file) await unlinkUploadIfAny(`/uploads/${req.file.filename}`)
    res.status(500).json({ error: 'Failed to update banner' })
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
    res.status(204).send()
  } catch {
    res.status(500).json({ error: 'Failed to delete banner' })
  }
})
