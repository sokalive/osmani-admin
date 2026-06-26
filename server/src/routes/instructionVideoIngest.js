import { Router } from 'express'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import {
  buildInstructionVideoFilename,
  getInstructionVideoIngestToken,
  resolveInstructionVideoDiskPath,
  verifyInstructionVideoFileExists,
} from '../lib/instructionVideoFileStorage.js'
import { collectInstructionVideoMetadata } from '../lib/instructionVideoMetadata.js'
import { ensureInstructionVideosDir, INSTRUCTION_VIDEOS_DIR, uploadInstructionVideo } from '../multerUpload.js'

export const instructionVideoIngestRouter = Router()

const ingestUpload = uploadInstructionVideo.single('video')

function requireIngestToken(req, res, next) {
  const expected = getInstructionVideoIngestToken()
  if (!expected) {
    return res.status(503).json({ success: false, error: 'Instruction video ingest token not configured' })
  }
  const provided = String(
    req.headers['x-instruction-ingest-token'] ||
      req.headers['x-notification-ingest-token'] ||
      req.headers['x-admin-token'] ||
      '',
  ).trim()
  if (!provided || provided !== expected) {
    return res.status(401).json({ success: false, error: 'Unauthorized' })
  }
  return next()
}

async function finishIngest(req, res) {
  if (!req.file?.filename) {
    return res.status(400).json({ success: false, error: 'video file is required' })
  }
  const uploadPath = `/uploads/videos/${req.file.filename}`
  const diskPath = resolveInstructionVideoDiskPath(uploadPath)
  const exists = diskPath ? await verifyInstructionVideoFileExists(uploadPath) : false
  if (!exists) {
    return res.status(500).json({ success: false, error: 'VPS file missing after ingest' })
  }
  const metadata = await collectInstructionVideoMetadata(diskPath, { sizeBytes: req.file.size })
  res.json({
    ok: true,
    success: true,
    filename: req.file.filename,
    path: req.file.path,
    uploadPath,
    bytes: metadata.fileSize ?? req.file.size,
    storage: 'vps',
    metadata,
  })
}

function resolveIngestFilename(req) {
  const channelId = String(req.query.channelId ?? req.headers['x-channel-id'] ?? '').trim()
  const fromHeader = String(req.query.filename ?? req.headers['x-filename'] ?? '').trim()
  if (fromHeader && fromHeader.startsWith('instruction-video-')) {
    return { channelId, filename: path.basename(fromHeader) }
  }
  const ext = path.extname(fromHeader) || '.mp4'
  return { channelId, filename: buildInstructionVideoFilename(channelId, ext) }
}

/** Raw stream PUT — Render pipes video bytes without buffering on Render disk. */
instructionVideoIngestRouter.put(
  '/internal/instruction-videos',
  requireIngestToken,
  async (req, res) => {
    try {
      const { channelId, filename } = resolveIngestFilename(req)
      if (!filename.startsWith('instruction-video-')) {
        return res.status(400).json({ success: false, error: 'invalid filename' })
      }
      ensureInstructionVideosDir()
      const actualDest = path.join(INSTRUCTION_VIDEOS_DIR, path.basename(filename))
      let written = 0
      const out = createWriteStream(actualDest)
      req.on('data', (chunk) => {
        written += chunk.length
      })
      req.pipe(out)
      out.on('finish', async () => {
        const uploadPath = `/uploads/videos/${path.basename(actualDest)}`
        const exists = await verifyInstructionVideoFileExists(uploadPath)
        if (!exists) {
          return res.status(500).json({ success: false, error: 'VPS file missing after stream ingest' })
        }
        const metadata = await collectInstructionVideoMetadata(actualDest, { sizeBytes: written })
        res.json({
          ok: true,
          success: true,
          channelId,
          filename: path.basename(actualDest),
          path: actualDest,
          uploadPath,
          bytes: written,
          storage: 'vps',
          metadata,
        })
      })
      out.on('error', (e) => {
        res.status(500).json({ success: false, error: String(e.message || e) })
      })
    } catch (e) {
      res.status(500).json({ success: false, error: String(e.message || e) })
    }
  },
)

/** Multipart ingest fallback. */
instructionVideoIngestRouter.post(
  '/internal/instruction-videos',
  requireIngestToken,
  (req, res, next) => {
    const channelId = String(req.query.channelId ?? req.headers['x-channel-id'] ?? '').trim()
    if (channelId) req.params = { ...req.params, id: channelId }
    ingestUpload(req, res, (err) => {
      if (err) {
        return res.status(400).json({ success: false, error: String(err.message || err) })
      }
      next()
    })
  },
  finishIngest,
)
