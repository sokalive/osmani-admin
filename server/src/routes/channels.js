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
import {
  deleteChannelById,
  getChannelById,
  getNextChannelId,
  insertChannel,
  readChannels,
  updateChannel,
} from '../store.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'

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
  } catch (e) {
    console.error('[channels] GET / failed:', e)
    res.status(500).json({ error: String(e.message || e) })
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
    const nextId = await getNextChannelId()
    const now = new Date().toISOString()
    const created = mergeChannelRecord(null, parsed, nextId, now)
    await insertChannel(created)
    liveSyncBus.publish('config.channels_changed', {
      topics: ['config'],
      action: 'created',
      channelId: created.id,
    })
    res.status(201).json(channelToResponse(created, req))
  } catch (e) {
    console.error('[channels] POST / failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

channelsRouter.put('/:id', maybeUpload, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10)
    if (Number.isNaN(id)) {
      if (req.file) await fs.unlink(path.join(UPLOADS_DIR, req.file.filename)).catch(() => {})
      return res.status(400).json({ error: 'Invalid id' })
    }
    const existingRow = await getChannelById(id)
    if (!existingRow) {
      if (req.file) await fs.unlink(path.join(UPLOADS_DIR, req.file.filename)).catch(() => {})
      return res.status(404).json({ error: 'Channel not found' })
    }
    const existing = migrateStoredChannel(existingRow)
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
    await updateChannel(updated)
    liveSyncBus.publish('config.channels_changed', {
      topics: ['config'],
      action: 'updated',
      channelId: updated.id,
    })
    res.json(channelToResponse(updated, req))
  } catch (e) {
    console.error('[channels] PUT /:id failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

channelsRouter.delete('/:id', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10)
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: 'Invalid id' })
    }
    const found = await getChannelById(id)
    if (!found) {
      return res.status(404).json({ error: 'Channel not found' })
    }
    const m = migrateStoredChannel(found)
    if (m.thumbnail?.startsWith('/uploads/')) {
      const f = uploadsFilePathFromThumbnail(m.thumbnail)
      if (f) await fs.unlink(path.join(UPLOADS_DIR, f)).catch(() => {})
    }
    await deleteChannelById(id)
    liveSyncBus.publish('config.channels_changed', {
      topics: ['config'],
      action: 'deleted',
      channelId: id,
    })
    res.status(204).send()
  } catch (e) {
    console.error('[channels] DELETE /:id failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})
