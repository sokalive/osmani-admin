import { Router } from 'express'
import {
  getDeviceTrialWatchStatus,
  recordDeviceTrialWatchHeartbeat,
  startDeviceTrialWatch,
} from '../lib/trialWatchStore.js'
import { loadTrialWatchSettings, trialWatchSettingsToPublicPayload } from '../lib/trialWatchSettings.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'

export const trialWatchRouter = Router()

function readDeviceId(req) {
  const b = req.body && typeof req.body === 'object' ? req.body : {}
  return String(
    req.query.device_id ??
      req.query.deviceId ??
      b.device_id ??
      b.deviceId ??
      req.headers['x-device-id'] ??
      '',
  ).trim()
}

function readFingerprint(req) {
  const b = req.body && typeof req.body === 'object' ? req.body : {}
  return String(
    b.fingerprint ??
      b.device_fingerprint ??
      b.deviceFingerprint ??
      req.query.fingerprint ??
      req.headers['x-device-fingerprint'] ??
      '',
  ).trim()
}

trialWatchRouter.get('/status', async (req, res) => {
  try {
    const deviceId = readDeviceId(req)
    if (!deviceId) return res.status(400).json({ ok: false, error: 'device_id is required' })
    res.setHeader('Cache-Control', 'no-store')
    const status = await getDeviceTrialWatchStatus(deviceId, readFingerprint(req))
    res.json({ ok: true, ...status })
  } catch (e) {
    console.error('[trial-watch/status]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

trialWatchRouter.post('/start', async (req, res) => {
  try {
    const deviceId = readDeviceId(req)
    const fingerprint = readFingerprint(req)
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const installInstanceId = String(
      b.install_instance_id ?? b.installInstanceId ?? '',
    ).trim()
    if (!deviceId) return res.status(400).json({ ok: false, error: 'device_id is required' })
    const result = await startDeviceTrialWatch(deviceId, fingerprint, installInstanceId)
    if (!result.ok) return res.status(400).json(result)
    res.json(result)
  } catch (e) {
    console.error('[trial-watch/start]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

trialWatchRouter.post('/heartbeat', async (req, res) => {
  try {
    const deviceId = readDeviceId(req)
    const fingerprint = readFingerprint(req)
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    if (!deviceId) return res.status(400).json({ ok: false, error: 'device_id is required' })
    const trialSeconds = Number(b.trial_seconds ?? b.trialSeconds ?? b.watching_seconds ?? 0)
    const previewSeconds = Number(b.preview_seconds ?? b.previewSeconds ?? 0)
    const result = await recordDeviceTrialWatchHeartbeat(deviceId, fingerprint, {
      trialSeconds,
      previewSeconds,
    })
    if (!result.ok) return res.status(400).json(result)
    res.json(result)
  } catch (e) {
    console.error('[trial-watch/heartbeat]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Public read-only trial config for runtime clients. */
trialWatchRouter.get('/config', async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store')
    const settings = await loadTrialWatchSettings()
    const snap = liveSyncBus.snapshot()
    res.json(trialWatchSettingsToPublicPayload(settings, snap.configVersion))
  } catch (e) {
    console.error('[trial-watch/config]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})
