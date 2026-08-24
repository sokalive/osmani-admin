import fs from 'node:fs/promises'
import path from 'node:path'
import { Router } from 'express'
import {
  buildDuplicateChannelRecord,
  channelToResponse,
  isInstructionVideoChannelRow,
  mergeChannelRecord,
  migrateStoredChannel,
  parseChannelInput,
  uploadsFilePathFromThumbnail,
  uploadsRelativePathFromUrl,
} from '../channelNormalize.js'
import {
  getUploadStorageLastError,
  initUploadStorage,
  isUploadStorageReady,
  sendUploadError,
  UPLOADS_DIR,
  uploadInstructionVideo,
  uploadThumbnail,
} from '../multerUpload.js'
import { afterImageMulter } from '../lib/imageMulterPipeline.js'
import { assertUploadedImageFileReady } from '../lib/uploadDiskSafety.js'
import {
  buildPublicInstructionVideoUrl,
  INSTRUCTION_VIDEO_UPLOAD_LOG,
  INSTRUCTION_VIDEO_UPLOAD_TIMEOUT_MS,
  instructionVideoUploadPath,
} from '../lib/instructionVideoUpload.js'
import {
  getInstructionVideoIngestToken,
  mustUseRemoteInstructionVideoStorage,
  resolveInstructionVideoDiskPath,
  verifyInstructionVideoFileExists,
} from '../lib/instructionVideoFileStorage.js'
import { collectInstructionVideoMetadata } from '../lib/instructionVideoMetadata.js'
import {
  deleteChannelById,
  getChannelById,
  getNextChannelId,
  getNextChannelSortOrder,
  insertChannel,
  readChannels,
  reorderChannels,
  updateChannel,
  updateInstructionVideoChannel,
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
import { extractVersionCodeFromRequest } from '../lib/clientApiTelemetry.js'
import { instructionChannelVisibleForClient } from '../lib/instructionVideoChannel.js'

export const channelsRouter = Router()

async function notifyChannelCatalogChange(action, channelId = null) {
  await publishChannelCatalogChange(action, channelId)
}

const upload = uploadThumbnail.single('thumbnail')
const uploadVideo = uploadInstructionVideo.single('video')

function runUpload(req, res, next) {
  upload(req, res, (err) => {
    void afterImageMulter(req, res, next, err)
  })
}

/** Multipart only when admin sends FormData; JSON for quick toggles. */
function maybeUpload(req, res, next) {
  if (req.is('multipart/form-data')) {
    return runUpload(req, res, next)
  }
  return next()
}

function runVideoUpload(req, res, next) {
  uploadVideo(req, res, (err) => {
    if (err) {
      console.error(INSTRUCTION_VIDEO_UPLOAD_LOG, 'multer_error', {
        channelId: req.params?.id,
        error: String(err.message || err),
      })
      res.status(400).json({ error: String(err.message || err) })
      return
    }
    next()
  })
}

function instructionVideoUploadTimeout(req, res, next) {
  req.setTimeout(INSTRUCTION_VIDEO_UPLOAD_TIMEOUT_MS)
  res.setTimeout(INSTRUCTION_VIDEO_UPLOAD_TIMEOUT_MS)
  next()
}

function requireUploadStorage(req, res, next) {
  if (isUploadStorageReady()) return next()
  const retried = initUploadStorage()
  if (retried.ok) return next()
  res.status(503).json({
    success: false,
    error: 'Upload storage unavailable',
    detail: retried.error || getUploadStorageLastError(),
  })
}

async function unlinkUploadRelative(relativePath) {
  const rel = uploadsRelativePathFromUrl(relativePath) || String(relativePath ?? '').trim()
  if (!rel) return
  await fs.unlink(path.join(UPLOADS_DIR, rel)).catch(() => {})
}

channelsRouter.get('/', apiResponseCacheExact('channels'), async (req, res) => {
  const t0 = Date.now()
  try {
    const clientVersion = extractVersionCodeFromRequest(req)
    const list = await readChannels()
    const visibleList =
      clientVersion > 0
        ? list.filter((c) => {
            if (!isInstructionVideoChannelRow(c)) return true
            return instructionChannelVisibleForClient(c, clientVersion)
          })
        : list
    const skipWarm =
      String(req.headers['x-osmani-skip-mpingo-warm'] || req.query.lite || '').trim() === '1' ||
      String(process.env.MPINGO_WARM_ON_CHANNEL_LIST || 'background').toLowerCase() === 'off'
    if (skipWarm) {
      /* admin lite / disabled */
    } else if (String(process.env.MPINGO_WARM_ON_CHANNEL_LIST || 'background').toLowerCase() === 'sync') {
      await warmMpingoMetadataCache(list)
    } else {
      void warmMpingoMetadataCache(visibleList).catch((e) => {
        console.error('[channels] background mpingo warm failed:', e)
      })
    }
    const payload = visibleList.map((c) => {
      const api = channelToResponse(c, req, clientVersion)
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
    if (req.file?.filename) {
      await assertUploadedImageFileReady(req.file.filename)
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
    if (req.file?.filename) await fs.unlink(path.join(UPLOADS_DIR, req.file.filename)).catch(() => {})
    return sendUploadError(res, e, req, { status: 500 })
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
      if (req.file) await fs.unlink(path.join(UPLOADS_DIR, req.file.filename)).catch(() => {})
      return res.status(404).json({ error: 'Channel not found' })
    }
    const existing = migrateStoredChannel(existingRow)
    if (isInstructionVideoChannelRow(existing)) {
      return res.status(403).json({ error: 'System instruction channels cannot be duplicated' })
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
    const instruction = isInstructionVideoChannelRow(existing)
    const parsed = parseChannelInput(req.body, req.file, existing)
    if (!parsed.name || (!instruction && !parsed.url)) {
      if (req.file) await fs.unlink(path.join(UPLOADS_DIR, req.file.filename)).catch(() => {})
      return res.status(400).json({ error: 'name and url (stream URL) are required' })
    }

    if (req.file?.filename) {
      await assertUploadedImageFileReady(req.file.filename)
    }

    const updated = mergeChannelRecord(existing, parsed, id, new Date().toISOString())
    await updateChannel(updated)

    if (req.file) {
      const oldFile = uploadsFilePathFromThumbnail(existing.thumbnail)
      if (oldFile && oldFile !== req.file.filename) {
        await fs.unlink(path.join(UPLOADS_DIR, oldFile)).catch(() => {})
      }
    }

    await notifyChannelCatalogChange('updated', updated.id)
    void triggerServerHealthBroadcast().catch((err) => {
      console.error('[channels] health refresh after update failed:', err)
    })
    const updatedBody = channelToResponse(updated, req, extractVersionCodeFromRequest(req))
    logChannelStreamDiagWrite(updatedBody, { scope: 'channels.PUT_response' })
    res.json(updatedBody)
  } catch (e) {
    console.error('[channels] PUT /:id failed:', e)
    if (req.file?.filename) await fs.unlink(path.join(UPLOADS_DIR, req.file.filename)).catch(() => {})
    return sendUploadError(res, e, req, { status: 500 })
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
    if (m.isSystemLocked || isInstructionVideoChannelRow(m)) {
      return res.status(403).json({ error: 'This system channel cannot be deleted' })
    }
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

function requireInstructionVideoUploadStorage(req, res, next) {
  if (mustUseRemoteInstructionVideoStorage()) {
    const token = getInstructionVideoIngestToken()
    if (!token) {
      return res.status(503).json({
        success: false,
        error: 'Instruction video VPS ingest not configured',
      })
    }
    return next()
  }
  return requireUploadStorage(req, res, next)
}

channelsRouter.post(
  '/:id/instruction-video',
  requireAdminPanelAccess,
  requireInstructionVideoUploadStorage,
  instructionVideoUploadTimeout,
  runVideoUpload,
  async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10)
    if (Number.isNaN(id)) {
      if (req.file?.path) await fs.unlink(req.file.path).catch(() => {})
      return res.status(400).json({ success: false, error: 'Invalid id' })
    }
    const existingRow = await getChannelById(id)
    if (!existingRow) {
      if (req.file?.path) await fs.unlink(req.file.path).catch(() => {})
      return res.status(404).json({ success: false, error: 'Channel not found' })
    }
    const existing = migrateStoredChannel(existingRow)
    if (!isInstructionVideoChannelRow(existing)) {
      if (req.file?.path) await fs.unlink(req.file.path).catch(() => {})
      return res.status(400).json({
        success: false,
        error: 'Only the VIDEO instruction channel accepts video uploads',
      })
    }
    if (String(existing.channelKind ?? '').toLowerCase() !== 'instruction_video') {
      if (req.file?.path) await fs.unlink(req.file.path).catch(() => {})
      return res.status(403).json({
        success: false,
        error: 'Upload blocked: channel_kind must be instruction_video',
      })
    }
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'video file is required' })
    }

    const uploadPath = instructionVideoUploadPath(req.file.filename)
    const videoUrl = buildPublicInstructionVideoUrl(req, uploadPath)

    if (mustUseRemoteInstructionVideoStorage() && videoUrl) {
      try {
        const headRes = await fetch(videoUrl, { method: 'HEAD', signal: AbortSignal.timeout(15_000) })
        if (!headRes.ok) {
          return res.status(502).json({
            success: false,
            error: `VPS video not reachable after upload (HTTP ${headRes.status})`,
          })
        }
      } catch (headErr) {
        return res.status(502).json({
          success: false,
          error: `VPS video verification failed: ${headErr?.message || headErr}`,
        })
      }
    } else {
      const fileExists = await verifyInstructionVideoFileExists(uploadPath)
      if (!fileExists) {
        if (req.file?.path) await fs.unlink(req.file.path).catch(() => {})
        return res.status(500).json({ success: false, error: 'Uploaded video file missing on VPS' })
      }
    }

    let metadata = req.file.instructionVideoMetadata || {}
    const diskPath = resolveInstructionVideoDiskPath(uploadPath)
    if (diskPath && !metadata.checksum) {
      metadata = await collectInstructionVideoMetadata(diskPath, { sizeBytes: req.file.size })
    }

    const uploadedBy = String(req.adminAuth?.email || req.headers['x-admin-token'] || 'admin').trim()

    const priorPaths = [existing.instructionVideoUrl, existing.url].filter(Boolean)
    for (const prior of priorPaths) {
      const rel = uploadsRelativePathFromUrl(prior)
      const nextRel = uploadsRelativePathFromUrl(uploadPath)
      if (rel && rel !== nextRel) {
        await unlinkUploadRelative(rel)
      }
    }

    const updated = await updateInstructionVideoChannel(id, {
      url: uploadPath,
      instructionVideoUrl: videoUrl,
      instructionVideoStatus: 'ready',
      instructionVideoFileSize: metadata.fileSize ?? req.file.size ?? null,
      instructionVideoDurationSec: metadata.durationSec ?? null,
      instructionVideoWidth: metadata.width ?? null,
      instructionVideoHeight: metadata.height ?? null,
      instructionVideoUploadedAt: new Date().toISOString(),
      instructionVideoUploadedBy: uploadedBy,
      instructionVideoChecksum: metadata.checksum ?? '',
    })
    if (!updated) {
      if (req.file?.path) await fs.unlink(req.file.path).catch(() => {})
      return res.status(403).json({
        success: false,
        error: 'Upload rejected: not an instruction_video channel',
      })
    }

    console.log(INSTRUCTION_VIDEO_UPLOAD_LOG, 'ready', {
      channelId: id,
      videoUrl,
      bytes: metadata.fileSize ?? req.file.size,
      checksum: metadata.checksum,
      durationSec: metadata.durationSec,
      resolution: metadata.width && metadata.height ? `${metadata.width}x${metadata.height}` : null,
      uploadedBy,
      remote: mustUseRemoteInstructionVideoStorage(),
    })

    await notifyChannelCatalogChange('updated', id)
    void triggerServerHealthBroadcast().catch((err) => {
      console.error('[channels] health refresh after instruction video upload failed:', err)
    })

    res.json({
      success: true,
      video_url: videoUrl,
      message: 'Upload successful',
      instruction_video_status: 'ready',
      instruction_video_metadata: {
        file_size: metadata.fileSize ?? req.file.size ?? null,
        duration_sec: metadata.durationSec ?? null,
        width: metadata.width ?? null,
        height: metadata.height ?? null,
        checksum: metadata.checksum ?? '',
        uploaded_by: uploadedBy,
      },
      channel: channelToResponse(updated, req, extractVersionCodeFromRequest(req)),
    })
  } catch (e) {
    console.error('[channels] POST /:id/instruction-video failed:', e)
    if (req.file?.path) await fs.unlink(req.file.path).catch(() => {})
    res.status(500).json({ success: false, error: String(e.message || e) })
  }
},
)
