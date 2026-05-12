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
    void (async () => {
      try {
        const payload = await loadGlobalAppModesPayload()
        send('app_modes', { ...payload, reason: 'init' })
      } catch (e) {
        console.error('[sync/stream] app_modes init failed:', e)
      }
    })()
  }

  const handler = (packet) => {
    const hasTopic = topics.some((topic) => packet?.payload?.topics?.includes(topic))
    if (!hasTopic) return
    if (topics.includes('config') && packet?.payload?.modes) {
      void (async () => {
        try {
          const payload = await loadGlobalAppModesPayload()
          send('app_modes', { ...payload, reason: String(packet.event || 'sync') })
        } catch (e) {
          console.error('[sync/stream] app_modes sync failed:', e)
        }
      })()
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
