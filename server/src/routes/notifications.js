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
import { isOneSignalConfigured, sendOneSignalTestTargetedPush } from '../lib/oneSignalPush.js'
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

/**
 * Temporary admin verification: send one notification to explicit OneSignal IDs
 * (no segments/filters). Does not touch app SDK, FCM, or registration flow.
 *
 * Body (JSON): { subscriptionId?, onesignalUserId?, playerId?, title?, message?, url? }
 * Aliases: subscription_id, onesignal_id, player_id.
 * Priority: subscriptionId → onesignalUserId (User ID) → playerId.
 * Env when body empty: fills ONESIGNAL_DEBUG_SUBSCRIPTION_ID, ONESIGNAL_DEBUG_ONESIGNAL_USER_ID,
 * and ONESIGNAL_DEBUG_PLAYER_ID into the same fields; sendOneSignalTestTargetedPush prefers
 * subscription → onesignal user → player.
 */
notificationsRouter.post('/notifications/onesignal-test-push', requireAdminPanelAccess, async (req, res) => {
  try {
    if (!isOneSignalConfigured()) {
      return res.status(503).json({
        error:
          'OneSignal is not configured. Set ONESIGNAL_APP_ID and ONESIGNAL_REST_API_KEY on the server.',
      })
    }
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const envSub = String(process.env.ONESIGNAL_DEBUG_SUBSCRIPTION_ID ?? '').trim()
    const envOsUser = String(process.env.ONESIGNAL_DEBUG_ONESIGNAL_USER_ID ?? '').trim()
    const envPlayer = String(process.env.ONESIGNAL_DEBUG_PLAYER_ID ?? '').trim()
    let subscriptionId = String(b.subscriptionId ?? b.subscription_id ?? '').trim()
    let onesignalUserId = String(
      b.onesignalUserId ?? b.onesignal_id ?? b.oneSignalUserId ?? b.onesignalUserID ?? '',
    ).trim()
    let playerId = String(b.playerId ?? b.player_id ?? '').trim()
    if (!subscriptionId && !onesignalUserId && !playerId) {
      subscriptionId = envSub
      onesignalUserId = envOsUser
      playerId = envPlayer
    }
    if (!subscriptionId && !onesignalUserId && !playerId) {
      return res.status(400).json({
        error:
          'Pass subscriptionId (push subscription UUID), onesignalUserId (User ID / onesignal_id), or playerId in JSON; or set ONESIGNAL_DEBUG_SUBSCRIPTION_ID, ONESIGNAL_DEBUG_ONESIGNAL_USER_ID, or ONESIGNAL_DEBUG_PLAYER_ID in server env.',
      })
    }
    const fromBodySub = String(b.subscriptionId ?? b.subscription_id ?? '').trim()
    const fromBodyOs = String(b.onesignalUserId ?? b.onesignal_id ?? b.oneSignalUserId ?? b.onesignalUserID ?? '').trim()
    const fromBodyPlayer = String(b.playerId ?? b.player_id ?? '').trim()
    const title = String(b.title ?? 'Osmani admin test').trim()
    const message = String(b.message ?? 'Backend OneSignal delivery test').trim()
    const url = String(b.url ?? 'osmani://home').trim()
    console.log(
      JSON.stringify({
        oneSignalDiag: true,
        phase: 'route_inputs',
        source: 'notifications/onesignal-test-push',
        subscriptionId: subscriptionId || null,
        onesignalUserId: onesignalUserId || null,
        playerId: playerId || null,
        matchedEnv: {
          subscriptionId: subscriptionId && envSub && subscriptionId === envSub,
          onesignalUserId: onesignalUserId && envOsUser && onesignalUserId === envOsUser,
          playerId: playerId && envPlayer && playerId === envPlayer,
        },
        bodyHad: {
          subscriptionId: Boolean(fromBodySub),
          onesignalUserId: Boolean(fromBodyOs),
          playerId: Boolean(fromBodyPlayer),
        },
      }),
    )
    const result = await sendOneSignalTestTargetedPush({
      subscriptionIds: subscriptionId ? [subscriptionId] : [],
      oneSignalUserIds: subscriptionId ? [] : onesignalUserId ? [onesignalUserId] : [],
      playerIds: subscriptionId || onesignalUserId ? [] : playerId ? [playerId] : [],
      title,
      message,
      url,
    })
    const targeting = subscriptionId
      ? 'include_subscription_ids'
      : onesignalUserId
        ? 'include_aliases.onesignal_id + target_channel:push'
        : 'include_player_ids'
    res.setHeader('Cache-Control', 'no-store')
    res.json({
      ok: true,
      onesignalId: result.id,
      recipients: result.recipients,
      targeting,
      raw: result.raw,
    })
  } catch (e) {
    const message = String(e.message || e)
    const status = /OneSignal is not configured|OneSignal API error/i.test(message) ? 503 : 400
    console.error('[notifications] onesignal-test-push failed:', e)
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
