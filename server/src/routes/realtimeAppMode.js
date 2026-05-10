import { Router } from 'express'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { loadGlobalAppModesPayload } from './globalAppSettings.js'

export const realtimeAppModeRouter = Router()

const MODE_POLL_MS = Math.min(60_000, Math.max(1500, Number(process.env.MODE_SSE_POLL_MS) || 2500))

function writeAppModes(res, body) {
  res.write(`event: app_modes\ndata: ${JSON.stringify(body)}\n\n`)
}

/** GET /api/realtime/app-mode — small JSON for aggressive polling (fallback). */
realtimeAppModeRouter.get('/app-mode', async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store')
    const payload = await loadGlobalAppModesPayload()
    res.json(payload)
  } catch (e) {
    console.error('[realtime/app-mode]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/**
 * GET /api/realtime/mode-stream — SSE: initial app_modes, push on settings/mode change, poll fallback.
 * Mobile / web clients: listen for `app_modes` ({ maintenance_mode, emergency_mode, free_mode, v, ... }).
 */
realtimeAppModeRouter.get('/mode-stream', (_req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()

  const flush = async (reason = 'sync') => {
    try {
      const p = await loadGlobalAppModesPayload()
      writeAppModes(res, { ...p, reason })
    } catch (e) {
      console.error('[mode-stream] flush failed:', e)
    }
  }

  void flush('init')

  const onBus = (packet) => {
    if (packet?.payload?.modes) void flush(String(packet.event || 'event'))
  }

  liveSyncBus.on('sync', onBus)

  const poll = setInterval(() => {
    void flush('poll')
  }, MODE_POLL_MS)

  const heartbeat = setInterval(() => {
    res.write(': ping\n\n')
  }, 20_000)

  _req.on('close', () => {
    clearInterval(poll)
    clearInterval(heartbeat)
    liveSyncBus.off('sync', onBus)
    try {
      res.end()
    } catch {
      // no-op
    }
  })
})
