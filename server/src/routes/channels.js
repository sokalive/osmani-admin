import fs from 'node:fs/promises'
import path from 'node:path'
import { Router } from 'express'
import {
  buildDuplicateChannelRecord,
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
  getNextChannelSortOrder,
  insertChannel,
  readChannels,
  reorderChannels,
  updateChannel,
} from '../store.js'
import { publishChannelCatalogChange, invalidateChannelCatalogCaches } from '../lib/channelCatalogSync.js'
import { requireAdminPanelAccess } from '../middleware/adminPanelAuthGate.js'
import {
  logChannelStreamDiagGet,
  logChannelStreamDiagList,
  logChannelStreamDiagWrite,
} from '../lib/channelStreamDiagnostics.js'
import { apiResponseCacheExact } from '../middleware/apiResponseCache.js'
import { warmMpingoMetadataCache } from '../lib/mpingoPlayerMetadata.js'
import { applyChannelsRoutingHeaders } from '../lib/mpingoRoutingSync.js'
import { triggerServerHealthBroadcast } from './realtimeSettings.js'

export const channelsRouter = Router()

async function notifyChannelCatalogChange(action, channelId = null) {
  await publishChannelCatalogChange(action, channelId)
}

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

channelsRouter.get('/', apiResponseCacheExact('channels'), async (req, res) => {
  const t0 = Date.now()
  try {
    const list = await readChannels()
    const skipWarm =
      String(req.headers['x-osmani-skip-mpingo-warm'] || req.query.lite || '').trim() === '1' ||
      String(process.env.MPINGO_WARM_ON_CHANNEL_LIST || 'background').toLowerCase() === 'off'
    if (skipWarm) {
      /* admin lite / disabled */
    } else if (String(process.env.MPINGO_WARM_ON_CHANNEL_LIST || 'background').toLowerCase() === 'sync') {
      await warmMpingoMetadataCache(list)
    } else {
      void warmMpingoMetadataCache(list).catch((e) => {
        console.error('[channels] background mpingo warm failed:', e)
      })
    }
    const payload = list.map((c) => {
      const api = channelToResponse(c, req)
      logChannelStreamDiagGet(c, api, {
        db_read_to_response_ms: Date.now() - t0,
      })
      return api
    })
    logChannelStreamDiagList(payload, {
      handler_total_ms: Date.now() - t0,
    })
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Expires', '0')
    applyChannelsRoutingHeaders(res)
    res.json(payload)
  } catch (e) {
    console.error('[channels] GET / failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

channelsRouter.post('/', requireAdminPanelAccess, maybeUpload, async (req, res) => {
  try {
    const parsed = parseChannelInput(req.body, req.file, null)
    if (!parsed.name || !parsed.url) {
      if (req.file) {
        await fs.unlink(path.join(UPLOADS_DIR, req.file.filename)).catch(() => {})
      }
      return res.status(400).json({ error: 'name and url (stream URL) are required' })
    }
    const nextId = await getNextChannelId()
    const sortOrder = await getNextChannelSortOrder()
    const now = new Date().toISOString()
    const created = mergeChannelRecord(null, { ...parsed, sortOrder }, nextId, now)
    await insertChannel(created)
    await notifyChannelCatalogChange('created', created.id)
    void triggerServerHealthBroadcast().catch((err) => {
      console.error('[channels] health refresh after create failed:', err)
    })
    const createdBody = channelToResponse(created, req)
    logChannelStreamDiagWrite(createdBody, { scope: 'channels.POST_response' })
    res.status(201).json(createdBody)
  } catch (e) {
    console.error('[channels] POST / failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

channelsRouter.post('/:id/duplicate', requireAdminPanelAccess, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10)
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: 'Invalid id' })
    }
    const existingRow = await getChannelById(id)
    if (!existingRow) {
      return res.status(404).json({ error: 'Channel not found' })
    }
    const nextId = await getNextChannelId()
    const sortOrder = await getNextChannelSortOrder()
    const now = new Date().toISOString()
    const created = buildDuplicateChannelRecord(existingRow, {
      id: nextId,
      sortOrder,
      nowIso: now,
    })
    if (!created.name || !created.url) {
      return res.status(400).json({ error: 'Source channel is missing required name or stream URL' })
    }
    await insertChannel(created)
    await notifyChannelCatalogChange('duplicated', created.id)
    void triggerServerHealthBroadcast().catch((err) => {
      console.error('[channels] health refresh after duplicate failed:', err)
    })
    const body = channelToResponse(created, req)
    logChannelStreamDiagWrite(body, { scope: 'channels.POST_duplicate_response', sourceId: id })
    res.status(201).json(body)
  } catch (e) {
    console.error('[channels] POST /:id/duplicate failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

channelsRouter.post('/reorder', requireAdminPanelAccess, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const orders = Array.isArray(body.orders) ? body.orders : []
    if (orders.length === 0) {
      return res.status(400).json({ error: 'orders array required' })
    }
    const updated = await reorderChannels(orders)
    await notifyChannelCatalogChange('reordered', null)
    void triggerServerHealthBroadcast().catch((err) => {
      console.error('[channels] health refresh after reorder failed:', err)
    })
    res.json({ ok: true, updated })
  } catch (e) {
    console.error('[channels] POST /reorder failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

channelsRouter.put('/:id', requireAdminPanelAccess, maybeUpload, async (req, res) => {
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
    await notifyChannelCatalogChange('updated', updated.id)
    void triggerServerHealthBroadcast().catch((err) => {
      console.error('[channels] health refresh after update failed:', err)
    })
    const updatedBody = channelToResponse(updated, req)
    logChannelStreamDiagWrite(updatedBody, { scope: 'channels.PUT_response' })
    res.json(updatedBody)
  } catch (e) {
    console.error('[channels] PUT /:id failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

channelsRouter.delete('/:id', requireAdminPanelAccess, async (req, res) => {
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
    await notifyChannelCatalogChange('deleted', id)
    void triggerServerHealthBroadcast().catch((err) => {
      console.error('[channels] health refresh after delete failed:', err)
    })
    res.status(204).send()
  } catch (e) {
    console.error('[channels] DELETE /:id failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})
