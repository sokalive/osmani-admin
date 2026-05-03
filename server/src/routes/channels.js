import fs from 'node:fs/promises'
import path from 'node:path'
import { Router } from 'express'
import {
  channelToResponse,
  mergeChannelRecord,
  migrateStoredChannel,
  parseChannelInput,
  uploadsFilePathFromThumbnail,
} from '../channelNormalize.js'
import { UPLOADS_DIR, uploadThumbnail } from '../multerUpload.js'
import { readChannels, writeChannels } from '../store.js'

export const channelsRouter = Router()

const upload = uploadThumbnail.single('thumbnail')

function runUpload(req, res, next) {
  upload(req, res, (err) => {
    if (err) {
      res.status(400).json({ error: String(err.message || err) })
      return
    }
    next()
  })
}

/** Multipart only when admin sends FormData; JSON for quick toggles. */
function maybeUpload(req, res, next) {
  if (req.is('multipart/form-data')) {
    return runUpload(req, res, next)
  }
  return next()
}

channelsRouter.get('/', async (req, res) => {
  try {
    const list = await readChannels()
    const sorted = [...list]
      .map((c) => migrateStoredChannel(c))
      .sort((a, b) => Number(a.id) - Number(b.id))
    res.json(sorted.map((c) => channelToResponse(c, req)))
  } catch {
    res.status(500).json({ error: 'Failed to load channels' })
  }
})

channelsRouter.post('/', maybeUpload, async (req, res) => {
  try {
    const parsed = parseChannelInput(req.body, req.file, null)
    if (!parsed.name || !parsed.url) {
      if (req.file) {
        await fs.unlink(path.join(UPLOADS_DIR, req.file.filename)).catch(() => {})
      }
      return res.status(400).json({ error: 'name and url (stream URL) are required' })
    }
    const list = await readChannels()
    const nextId =
      list.length === 0 ? 1 : Math.max(...list.map((c) => Number(c.id)), 0) + 1
    const now = new Date().toISOString()
    const created = mergeChannelRecord(null, parsed, nextId, now)
    list.push(created)
    await writeChannels(list)
    res.status(201).json(channelToResponse(created, req))
  } catch {
    res.status(500).json({ error: 'Failed to create channel' })
  }
})

channelsRouter.put('/:id', maybeUpload, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10)
    if (Number.isNaN(id)) {
      if (req.file) await fs.unlink(path.join(UPLOADS_DIR, req.file.filename)).catch(() => {})
      return res.status(400).json({ error: 'Invalid id' })
    }
    const list = await readChannels()
    const idx = list.findIndex((c) => Number(c.id) === id)
    if (idx === -1) {
      if (req.file) await fs.unlink(path.join(UPLOADS_DIR, req.file.filename)).catch(() => {})
      return res.status(404).json({ error: 'Channel not found' })
    }
    const existing = migrateStoredChannel(list[idx])
    const parsed = parseChannelInput(req.body, req.file, existing)
    if (!parsed.name || !parsed.url) {
      if (req.file) await fs.unlink(path.join(UPLOADS_DIR, req.file.filename)).catch(() => {})
      return res.status(400).json({ error: 'name and url (stream URL) are required' })
    }

    if (req.file && existing.thumbnail?.startsWith('/uploads/')) {
      const oldFile = uploadsFilePathFromThumbnail(existing.thumbnail)
      if (oldFile && oldFile !== req.file.filename) {
        await fs.unlink(path.join(UPLOADS_DIR, oldFile)).catch(() => {})
      }
    }

    const updated = mergeChannelRecord(existing, parsed, id, new Date().toISOString())
    list[idx] = updated
    await writeChannels(list)
    res.json(channelToResponse(updated, req))
  } catch {
    res.status(500).json({ error: 'Failed to update channel' })
  }
})

channelsRouter.delete('/:id', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10)
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: 'Invalid id' })
    }
    const list = await readChannels()
    const found = list.find((c) => Number(c.id) === id)
    const next = list.filter((c) => Number(c.id) !== id)
    if (next.length === list.length) {
      return res.status(404).json({ error: 'Channel not found' })
    }
    const m = migrateStoredChannel(found)
    if (m.thumbnail?.startsWith('/uploads/')) {
      const f = uploadsFilePathFromThumbnail(m.thumbnail)
      if (f) await fs.unlink(path.join(UPLOADS_DIR, f)).catch(() => {})
    }
    await writeChannels(next)
    res.status(204).send()
  } catch {
    res.status(500).json({ error: 'Failed to delete channel' })
  }
})
