import { Router } from 'express'
import {
  createAdminNotification,
  deleteAllNotificationsAdmin,
  deleteNotificationById,
  flushDueNotifications,
  listNotificationsAdmin,
  listRuntimeNotifications,
  updateNotificationById,
} from '../lib/runtimeNotifications.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { requireAdminPanelAccess } from '../middleware/adminPanelAuthGate.js'

export const notificationsRouter = Router()

notificationsRouter.get('/notifications/runtime', async (req, res) => {
  try {
    const audience = String(req.query.audience ?? 'all').trim().toLowerCase()
    const notifications = await listRuntimeNotifications({ audience })
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

notificationsRouter.get('/notifications', requireAdminPanelAccess, async (_req, res) => {
  try {
    const rows = await listNotificationsAdmin()
    res.json(rows)
  } catch (e) {
    console.error('[notifications] GET failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

notificationsRouter.post('/notifications', requireAdminPanelAccess, async (req, res) => {
  try {
    const created = await createAdminNotification(req.body, req.adminAuth?.email || 'Admin')
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

notificationsRouter.put('/notifications/:id', requireAdminPanelAccess, async (req, res) => {
  try {
    const updated = await updateNotificationById(
      req.params.id,
      req.body,
      req.adminAuth?.email || 'Admin',
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
