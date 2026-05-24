import { Router } from 'express'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { recordSystemNotificationEvent } from '../lib/runtimeNotifications.js'
import {
  loadTrialWatchSettings,
  saveTrialWatchSettings,
  trialWatchSettingsToPublicPayload,
} from '../lib/trialWatchSettings.js'
import { requireAdminPanelAccess } from '../middleware/adminPanelAuthGate.js'

export const trialWatchSettingsRouter = Router()

trialWatchSettingsRouter.get('/', requireAdminPanelAccess, async (_req, res) => {
  try {
    const settings = await loadTrialWatchSettings()
    res.json({
      enabled: settings.enabled,
      trialMinutes: settings.trialMinutes,
      previewSeconds: settings.previewSeconds,
      previewAfterEnabled: settings.previewAfterEnabled,
    })
  } catch (e) {
    console.error('[settings/trial-watch] GET', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

trialWatchSettingsRouter.put('/', requireAdminPanelAccess, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const saved = await saveTrialWatchSettings(body)
    const snap = liveSyncBus.snapshot()
    const publicPayload = trialWatchSettingsToPublicPayload(saved, snap.configVersion)
    liveSyncBus.publish('config.trial_watch_changed', {
      topics: ['config'],
      action: 'updated',
      trial_watch: publicPayload,
      synced_at: new Date().toISOString(),
    })
    void recordSystemNotificationEvent('config.trial_watch_changed', {
      trial_watch_enabled: saved.enabled,
    }).catch((err) => {
      console.error('[settings/trial-watch] notification sync failed:', err)
    })
    res.json({
      enabled: saved.enabled,
      trialMinutes: saved.trialMinutes,
      previewSeconds: saved.previewSeconds,
      previewAfterEnabled: saved.previewAfterEnabled,
    })
  } catch (e) {
    console.error('[settings/trial-watch] PUT', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})
