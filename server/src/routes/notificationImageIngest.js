import { Router } from 'express'
import multer from 'multer'
import {
  getNotificationImageIngestToken,
  notificationImageRelativePath,
  writeNotificationImageLocal,
} from '../lib/notificationImageStorage.js'

export const notificationImageIngestRouter = Router()

const ingestUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Math.max(
      512 * 1024,
      Number(process.env.NOTIFICATION_IMAGE_MAX_INPUT_BYTES) || 15 * 1024 * 1024,
    ),
  },
})

function requireIngestToken(req, res, next) {
  const expected = getNotificationImageIngestToken()
  if (!expected) {
    return res.status(503).json({ ok: false, error: 'Notification image ingest token not configured' })
  }
  const provided = String(
    req.headers['x-notification-ingest-token'] ||
      req.headers['x-admin-token'] ||
      '',
  ).trim()
  if (!provided || provided !== expected) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' })
  }
  return next()
}

async function persistIngestPayload({ filename, buffer }) {
  const name = String(filename ?? '').trim()
  if (!name) throw new Error('filename is required')
  if (!name.startsWith('notif-')) throw new Error('filename must start with notif-')
  if (!buffer?.length) throw new Error('Image payload is empty')

  const stored = await writeNotificationImageLocal(buffer, name)
  const publicPath = notificationImageRelativePath(name) || stored.imageForDb
  return { publicPath, bytes: buffer.length }
}

/**
 * Internal VPS ingest — Render posts optimized notification images here (no Render disk).
 * Accepts multipart field `image` or JSON { filename, dataBase64 }.
 */
notificationImageIngestRouter.post(
  '/internal/notification-images',
  requireIngestToken,
  ingestUpload.single('image'),
  async (req, res) => {
    try {
      let filename = String(req.body?.filename ?? req.file?.originalname ?? '').trim()
      let buffer = req.file?.buffer

      if (!buffer?.length && req.body?.dataBase64) {
        try {
          buffer = Buffer.from(String(req.body.dataBase64), 'base64')
        } catch {
          return res.status(400).json({ ok: false, error: 'Invalid base64 payload' })
        }
      }

      if (!filename && req.file?.originalname) {
        filename = String(req.file.originalname).trim()
      }

      const { publicPath, bytes } = await persistIngestPayload({ filename, buffer })

      console.log('[notification-image-ingest] stored', {
        filename,
        bytes,
        path: publicPath,
      })

      res.json({
        ok: true,
        image: publicPath,
        imageForDb: publicPath,
        bytes,
        storage: 'vps',
      })
    } catch (e) {
      console.error('[notification-image-ingest]', e)
      const status = /required|must start|empty|Invalid/i.test(String(e.message || e)) ? 400 : 500
      res.status(status).json({ ok: false, error: String(e.message || e) })
    }
  },
)
