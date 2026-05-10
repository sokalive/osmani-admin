import { Router } from 'express'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { loadGlobalAppModesPayload } from './globalAppSettings.js'

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

  if (topics.includes('config')) {
    void loadGlobalAppModesPayload()
      .then((p) => send('app_modes', p))
      .catch((e) => console.error('[sync/stream] app_modes bootstrap failed:', e))
  }

  const handler = (packet) => {
    const hasTopic = topics.some((topic) => packet?.payload?.topics?.includes(topic))
    if (!hasTopic) return
    send(packet.event || 'sync', packet)
    const m = packet?.payload?.modes
    if (m && topics.includes('config')) {
      send('app_modes', {
        ok: true,
        v: packet.configVersion,
        ...m,
        server_time_ms: Date.now(),
      })
    }
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
