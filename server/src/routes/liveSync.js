import { Router } from 'express'
import { liveSyncBus } from '../lib/liveSyncBus.js'

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
  const deviceId = String(req.query.device_id ?? '').trim()
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

  const handler = (packet) => {
    const hasTopic = topics.some((topic) => packet?.payload?.topics?.includes(topic))
    if (!hasTopic) return
    const p = packet?.payload || {}
    const isScoped =
      p.scope === 'device' ||
      p.device_id != null ||
      p.source_device_id != null ||
      p.target_device_id != null
    if (isScoped) {
      if (!deviceId) return
      const recipients = [
        String(p.device_id ?? '').trim(),
        String(p.source_device_id ?? '').trim(),
        String(p.target_device_id ?? '').trim(),
      ].filter(Boolean)
      if (recipients.length > 0 && !recipients.includes(deviceId)) return
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
