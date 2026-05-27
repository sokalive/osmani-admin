import { Router } from 'express'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { loadGlobalAppModesPayload } from './globalAppSettings.js'
import { getWhatsAppSettingsPublicPayload } from './realtimeSettings.js'
import { loadTrialWatchSettings, trialWatchSettingsToPublicPayload } from '../lib/trialWatchSettings.js'
import { loadAppUpdatePublicPayload } from './appUpdate.js'

export const liveSyncRouter = Router()

function parseTopics(raw) {
  const s = String(raw ?? '')
  const parts = s
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
  const valid = new Set(['analytics', 'config'])
  const topics = parts.filter((p) => valid.has(p))
  return topics.length > 0 ? topics : ['analytics', 'config']
}

liveSyncRouter.get('/sync/stream', (req, res) => {
  const topics = parseTopics(req.query.topics)
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()

  const send = (event, data) => {
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }

  send('snapshot', {
    topics,
    ...liveSyncBus.snapshot(),
  })

  /** Legacy APK + admin Device Control listen for `app_settings_changed`; modes live in `app_modes` too. */
  function sendRuntimeModesPair(payload, reason) {
    const body = { ...payload, reason }
    send('app_modes', body)
    send('app_settings_changed', body)
  }

  if (topics.includes('config')) {
    void (async () => {
      try {
        const payload = await loadGlobalAppModesPayload()
        sendRuntimeModesPair(payload, 'init')
      } catch (e) {
        console.error('[sync/stream] app_modes init failed:', e)
      }
      try {
        const wa = await getWhatsAppSettingsPublicPayload()
        if (wa) {
          send('whatsapp_settings_changed', {
            topics: ['config'],
            enabled: wa.enabled,
            url: wa.url,
            synced_at: new Date().toISOString(),
          })
        }
      } catch (e) {
        console.error('[sync/stream] whatsapp_settings init failed:', e)
      }
      try {
        const settings = await loadTrialWatchSettings()
        const snap = liveSyncBus.snapshot()
        send('trial_watch_settings', {
          ...trialWatchSettingsToPublicPayload(settings, snap.configVersion),
          reason: 'init',
        })
      } catch (e) {
        console.error('[sync/stream] trial_watch init failed:', e)
      }
      try {
        const snap = liveSyncBus.snapshot()
        const appUpdate = await loadAppUpdatePublicPayload(snap.configVersion)
        send('app_update_settings', { ...appUpdate, reason: 'init' })
      } catch (e) {
        console.error('[sync/stream] app_update init failed:', e)
      }
    })()
  }

  const handler = (packet) => {
    const hasTopic = topics.some((topic) => packet?.payload?.topics?.includes(topic))
    if (!hasTopic) return
    const modes = packet?.payload?.modes
    if (topics.includes('config') && modes && typeof modes === 'object') {
      // Same-node instant push (no await): avoids race where DB read lags the in-memory publish.
      const immediate = {
        ok: true,
        v: packet.configVersion,
        free_mode: modes.free_mode === true,
        emergency_mode: modes.emergency_mode === true,
        maintenance_mode: modes.maintenance_mode === true,
        server_time_ms: Date.now(),
      }
      sendRuntimeModesPair(immediate, String(packet.event || 'sync'))
    }
    const tw = packet?.payload?.trial_watch
    if (topics.includes('config') && tw && typeof tw === 'object') {
      send('trial_watch_settings', { ...tw, reason: String(packet.event || 'sync') })
    }
    const au = packet?.payload?.app_update
    if (topics.includes('config') && au && typeof au === 'object') {
      send('app_update_settings', { ...au, reason: String(packet.event || 'sync') })
    }
    send(packet.event || 'sync', packet)
  }

  liveSyncBus.on('sync', handler)

  const ping = setInterval(() => {
    res.write(': ping\n\n')
  }, 20_000)

  req.on('close', () => {
    clearInterval(ping)
    liveSyncBus.off('sync', handler)
    try {
      res.end()
    } catch {
      // no-op
    }
  })
})
