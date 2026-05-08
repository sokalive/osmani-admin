import { Router } from 'express'
import { liveSyncBus } from '../lib/liveSyncBus.js'

export const liveSyncRouter = Router()

function normalizeDeviceId(v) {
  return String(v ?? '')
    .trim()
    .toLowerCase()
}

function shouldTraceScopedEvent(eventName, payload) {
  const e = String(eventName || '')
  if (e === 'transfer_confirmation_required') return true
  if (e === 'transfer_pending') return true
  if (e === 'transfer_completed') return true
  if (e === 'transfer_rejected') return true
  if (e === 'subscription_revoked' && payload?.pending_transfer_id) return true
  return false
}

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
  const deviceIdRaw = String(req.query.device_id ?? req.query.deviceId ?? '').trim()
  const deviceIdNorm = normalizeDeviceId(deviceIdRaw)
  console.log('[sync/stream] client connected', {
    device_id: deviceIdRaw || null,
    topics,
  })
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
    const eventName = String(packet?.event || 'sync')
    const p = packet?.payload || {}
    const trace = shouldTraceScopedEvent(eventName, p)
    const hasTopic = topics.some((topic) => p?.topics?.includes(topic))
    if (!hasTopic) {
      if (trace) {
        console.log('[sync/stream] skipped (topic)', {
          event: eventName,
          device_id: deviceIdRaw || null,
          topics,
          payload_topics: p?.topics || [],
        })
      }
      return
    }
    const isScoped =
      p.scope === 'device' ||
      p.device_id != null ||
      p.source_device_id != null ||
      p.target_device_id != null
    if (isScoped) {
      if (!deviceIdNorm) {
        if (trace) {
          console.log('[sync/stream] skipped (scoped, missing client device_id)', {
            event: eventName,
            source_device_id: p.source_device_id || null,
            target_device_id: p.target_device_id || null,
            pending_transfer_id: p.pending_transfer_id || null,
          })
        }
        return
      }
      const recipients = [
        normalizeDeviceId(p.device_id),
        normalizeDeviceId(p.source_device_id),
        normalizeDeviceId(p.target_device_id),
      ].filter(Boolean)
      const delivered = recipients.length === 0 || recipients.includes(deviceIdNorm)
      if (!delivered) {
        if (trace) {
          console.log('[sync/stream] skipped (recipient mismatch)', {
            event: eventName,
            client_device_id: deviceIdRaw,
            source_device_id: p.source_device_id || null,
            target_device_id: p.target_device_id || null,
            recipients,
            pending_transfer_id: p.pending_transfer_id || null,
          })
        }
        return
      }
      if (trace) {
        console.log('[sync/stream] delivering scoped event', {
          event: eventName,
          client_device_id: deviceIdRaw,
          source_device_id: p.source_device_id || null,
          target_device_id: p.target_device_id || null,
          pending_transfer_id: p.pending_transfer_id || null,
        })
      }
    }
    send(packet.event || 'sync', packet)
  }

  liveSyncBus.on('sync', handler)

  const ping = setInterval(() => {
    res.write(': ping\n\n')
  }, 20_000)

  req.on('close', () => {
    console.log('[sync/stream] client disconnected', {
      device_id: deviceIdRaw || null,
      topics,
    })
    clearInterval(ping)
    liveSyncBus.off('sync', handler)
    try {
      res.end()
    } catch {
      // no-op
    }
  })
})
