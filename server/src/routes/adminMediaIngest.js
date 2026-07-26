/**
 * Internal VPS ingest for admin channel/banner images mirrored from Render.
 * Accepts multipart `image` + `filename`, or JSON { filename, dataBase64 }.
 */
import { Router } from 'express'
import multer from 'multer'
import { persistImageBufferToUploads } from '../lib/uploadDiskSafety.js'

export const adminMediaIngestRouter = Router()

const ingestUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Math.max(1_048_576, Number(process.env.ADMIN_MEDIA_MAX_BYTES) || 12 * 1024 * 1024) },
})

function expectedToken() {
  return String(
    process.env.ADMIN_MEDIA_INGEST_TOKEN ||
      process.env.NOTIFICATION_IMAGE_INGEST_TOKEN ||
      process.env.APP_UPDATE_ADMIN_TOKEN ||
      process.env.ADMIN_API_TOKEN ||
      '',
  ).trim()
}

function requireIngestToken(req, res, next) {
  const expected = expectedToken()
  if (!expected) {
    return res.status(503).json({ ok: false, error: 'Admin media ingest token not configured' })
  }
  const provided = String(
    req.headers['x-admin-media-ingest-token'] || req.headers['x-admin-token'] || '',
  ).trim()
  if (!provided || provided !== expected) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' })
  }
  return next()
}

adminMediaIngestRouter.post(
  '/internal/admin-media',
  requireIngestToken,
  ingestUpload.single('image'),
  async (req, res) => {
    try {
      let filename = String(req.body?.filename ?? '').trim()
      let buffer = req.file?.buffer

      if (!buffer?.length && req.body?.dataBase64) {
        buffer = Buffer.from(String(req.body.dataBase64), 'base64')
      }
      if (!filename && req.file?.originalname) {
        filename = String(req.file.originalname).trim()
      }
      // Only allow simple upload basenames (no path traversal).
      filename = filename.replace(/\\/g, '/').split('/').pop() || ''
      if (!filename || filename.includes('..')) {
        return res.status(400).json({ ok: false, error: 'filename is required' })
      }
      if (!buffer?.length) {
        return res.status(400).json({ ok: false, error: 'image payload is empty' })
      }

      const stored = await persistImageBufferToUploads(buffer, {
        filename,
        originalname: filename,
        mimetype: req.file?.mimetype,
        skipMirror: true,
      })

      console.log('[admin-media-ingest] stored', {
        filename: stored.filename,
        bytes: buffer.length,
        path: stored.relativePath,
      })

      res.json({
        ok: true,
        filename: stored.filename,
        path: stored.relativePath,
        bytes: buffer.length,
      })
    } catch (e) {
      console.error('[admin-media-ingest] failed', e)
      res.status(500).json({ ok: false, error: String(e?.message || e) })
    }
  },
)
