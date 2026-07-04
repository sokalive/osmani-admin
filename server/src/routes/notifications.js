import { Router } from 'express'
import {
  createAdminNotification,
  deleteAllNotificationsAdmin,
  deleteNotificationById,
  flushDueNotifications,
  listNotificationsAdmin,
  listRuntimeNotifications,
  refreshNotificationStatsAdmin,
  resolveOneSignalPushImageUrl,
  syncStaleOneSignalStats,
  updateNotificationById,
} from '../lib/runtimeNotifications.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { fetchOneSignalSubscriptionDiagnostics } from '../lib/oneSignalDiagnostics.js'
import { isOneSignalConfigured } from '../lib/oneSignalPush.js'
import { persistOptimizedNotificationImage } from '../lib/notificationImageOptimize.js'
import { resolvePublicAssetUrl } from '../lib/cdnAssets.js'
import {
  getNotificationImageStorageDiagnostics,
  resolveNotificationImagePublicUrl,
} from '../lib/notificationImageStorage.js'
import { scheduleNotificationImageCleanup } from '../lib/notificationImageCleanup.js'
import { uploadNotificationImage, sendUploadError } from '../multerUpload.js'
import { requireAdminPanelAccess } from '../middleware/adminPanelAuthGate.js'

export const notificationsRouter = Router()

notificationsRouter.get('/notifications/runtime', async (req, res) => {
  try {
    const audience = String(req.query.audience ?? 'all').trim().toLowerCase()
    const notifications = await listRuntimeNotifications({ audience }, req)
    const snapshot = liveSyncBus.snapshot()
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Expires', '0')
    res.json({
      notifications,
      messages: notifications,
      v: snapshot.configVersion,
      server_time: snapshot.serverTime,
    })
  } catch (e) {
    console.error('[notifications/runtime] GET failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

notificationsRouter.get('/notifications', requireAdminPanelAccess, async (req, res) => {
  try {
    const rows = await listNotificationsAdmin(req)
    res.json(rows)
  } catch (e) {
    console.error('[notifications] GET failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

/** Read-only: app messageable_players, segment subscriber_count, backend vs dashboard request shape. */
notificationsRouter.get('/notifications/onesignal-diagnostics', requireAdminPanelAccess, async (_req, res) => {
  try {
    if (!isOneSignalConfigured()) {
      return res.status(503).json({
        error: 'OneSignal is not configured. Set ONESIGNAL_APP_ID and ONESIGNAL_REST_API_KEY on the server.',
      })
    }
    const report = await fetchOneSignalSubscriptionDiagnostics()
    res.setHeader('Cache-Control', 'no-store')
    res.json(report)
  } catch (e) {
    console.error('[notifications] onesignal-diagnostics failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

/** Optimize and store notification image (multipart field `image`). */
notificationsRouter.post(
  '/notifications/prepare-image',
  requireAdminPanelAccess,
  (req, res, next) => {
    uploadNotificationImage.single('image')(req, res, (err) => {
      if (err) {
        const message =
          err.code === 'LIMIT_FILE_SIZE'
            ? 'Image file is too large'
            : String(err.message || err)
        return res.status(400).json({ ok: false, error: message })
      }
      next()
    })
  },
  async (req, res) => {
    try {
      if (!req.file?.buffer?.length) {
        return res.status(400).json({ ok: false, error: 'image file is required (JPG, JPEG, PNG or WEBP)' })
      }
      const persisted = await persistOptimizedNotificationImage(req.file.buffer, {
        mime: req.file.mimetype,
      })
      const pushImageUrl = resolveNotificationImagePublicUrl(persisted.imageForDb)
      const previewUrl = pushImageUrl || resolvePublicAssetUrl(persisted.imageForDb, req) || persisted.imageForDb
      res.json({
        ok: true,
        image: persisted.imageForDb,
        imageForDb: persisted.imageForDb,
        previewUrl,
        pushImageUrl: pushImageUrl || null,
        pushReady: Boolean(pushImageUrl),
        storage: persisted.storage || getNotificationImageStorageDiagnostics().mode,
        originalBytes: persisted.originalBytes,
        compressedBytes: persisted.compressedBytes,
        width: persisted.width,
        height: persisted.height,
        format: persisted.format,
        savedPercent: persisted.savedPercent,
        message: pushImageUrl
          ? 'Image optimized and ready for push delivery'
          : 'Image saved; push image requires HTTPS public URL (check BASE_URL / CDN)',
      })
    } catch (e) {
      console.error('[notifications/prepare-image]', e)
      return sendUploadError(res, e, req, { status: 400 })
    }
  },
)

notificationsRouter.post('/notifications', requireAdminPanelAccess, async (req, res) => {
  try {
    const created = await createAdminNotification(req.body, req.adminAuth?.email || 'Admin', req)
    res.status(201).json(created)
  } catch (e) {
    const message = String(e.message || e)
    const status = /required/i.test(message)
      ? 400
      : /OneSignal is not configured|OneSignal API error/i.test(message)
        ? 503
        : 500
    console.error('[notifications] POST failed:', e)
    res.status(status).json({ error: message })
  }
})

notificationsRouter.post('/notifications/:id/sync-stats', requireAdminPanelAccess, async (req, res) => {
  try {
    const updated = await refreshNotificationStatsAdmin(req.params.id, req)
    if (!updated) {
      return res.status(404).json({ error: 'Notification not found' })
    }
    res.json(updated)
  } catch (e) {
    console.error('[notifications] sync-stats failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

notificationsRouter.put('/notifications/:id', requireAdminPanelAccess, async (req, res) => {
  try {
    const updated = await updateNotificationById(
      req.params.id,
      req.body,
      req.adminAuth?.email || 'Admin',
      req,
    )
    if (!updated) {
      return res.status(404).json({ error: 'Notification not found' })
    }
    res.json(updated)
  } catch (e) {
    const message = String(e.message || e)
    const status = /required/i.test(message) ? 400 : 500
    console.error('[notifications] PUT failed:', e)
    res.status(status).json({ error: message })
  }
})

notificationsRouter.delete('/notifications/all', requireAdminPanelAccess, async (_req, res) => {
  try {
    const deleted = await deleteAllNotificationsAdmin()
    res.json({ ok: true, deleted })
  } catch (e) {
    console.error('[notifications] DELETE /notifications/all failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

notificationsRouter.delete('/notifications/:id', requireAdminPanelAccess, async (req, res) => {
  try {
    const removed = await deleteNotificationById(req.params.id)
    if (!removed) {
      return res.status(404).json({ error: 'Notification not found' })
    }
    res.status(204).send()
  } catch (e) {
    console.error('[notifications] DELETE failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

void flushDueNotifications().catch((e) => {
  console.error('[notifications] initial flush failed:', e)
})

setInterval(() => {
  void flushDueNotifications().catch((e) => {
    console.error('[notifications] scheduled flush failed:', e)
  })
}, Math.max(10_000, Number(process.env.NOTIFICATIONS_SCHEDULER_MS) || 30_000))

setInterval(() => {
  void syncStaleOneSignalStats().catch((e) => {
    console.error('[notifications] OneSignal stats refresh failed:', e)
  })
}, Math.max(15_000, Number(process.env.ONESIGNAL_STATS_REFRESH_MS) || 30_000))

scheduleNotificationImageCleanup()
