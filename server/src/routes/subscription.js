import { Router } from 'express'
import * as billing from '../billingStore.js'
import { deviceSubscriptionBus } from '../lib/deviceSubscriptionBus.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'

export const subscriptionRouter = Router()

function countryFromRequest(req) {
  const raw =
    req.headers['cf-ipcountry'] ||
    req.headers['x-vercel-ip-country'] ||
    req.headers['x-country-code'] ||
    ''
  const c = String(raw ?? '').trim().toUpperCase()
  if (!c || c.length < 2) return null
  return c.slice(0, 2)
}

function rowToPublicStatus(row) {
  if (!row) return { active: false, status: null, expiresAt: null }
  const active = row.active_now === true && row.blocked_now !== true
  const status =
    row.blocked_now === true ? 'blocked' : active ? 'active' : row.status === 'active' ? 'expired' : row.status
  const exp = row.expires_at
  const expiresAt = exp instanceof Date ? exp.toISOString() : exp != null ? String(exp) : null
  return {
    active,
    /** legacy alias used by RN clients */
    isActive: active,
    status,
    expiresAt,
    blocked: row.blocked_now === true,
    blockReason: row.block_reason ? String(row.block_reason) : null,
  }
}

/** GET /subscription-status — primary unlock check by device_id (poll every ~3s as fallback). */
subscriptionRouter.get('/subscription-status', async (req, res) => {
  try {
    const deviceId = String(req.query.device_id ?? '').trim()
    if (!deviceId) {
      return res.status(400).json({ error: 'device_id is required' })
    }
    const country = countryFromRequest(req)
    await billing.touchLivePresence({ deviceId, country }).catch((e) => {
      console.error('[subscription-status] touchLivePresence failed:', e)
    })
    liveSyncBus.publish('analytics.session_heartbeat', { topics: ['analytics'], deviceId })
    const fp = String(req.query.fingerprint ?? req.headers['x-device-fingerprint'] ?? '').trim()
    const row = await billing.getDeviceSubscriptionAccessState(deviceId, fp)
    const pub = rowToPublicStatus(row)
    if (!pub.active) {
      const plans = await billing.listPlansWithSubscriberCounts().catch(() => [])
      return res.json({
        ...pub,
        playbackAllowed: false,
        plans: Array.isArray(plans)
          ? plans.map((p) => ({
              id: Number(p.id),
              name: String(p.name ?? ''),
              price: Number(p.price) || 0,
              duration_days: Number(p.duration_days) || 0,
            }))
          : [],
      })
    }
    res.json({ ...pub, playbackAllowed: true })
  } catch (e) {
    console.error('[subscription-status]', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

/** GET /subscription-stream — SSE realtime (same-node process). RN can use RN Firebase/other; web uses EventSource. */
subscriptionRouter.get('/subscription-stream', (req, res) => {
  const deviceId = String(req.query.device_id ?? '').trim()
  if (!deviceId) {
    res.status(400).json({ error: 'device_id is required' })
    return
  }
  const country = countryFromRequest(req)
  void billing.touchLivePresence({ deviceId, country }).catch((e) => {
    console.error('[subscription-stream] touchLivePresence failed:', e)
  })
  liveSyncBus.publish('analytics.session_heartbeat', { topics: ['analytics'], deviceId })
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()

  const toSsePayload = (row) => {
    const pub = rowToPublicStatus(row)
    return { isActive: pub.isActive === true, expiresAt: pub.expiresAt ?? null }
  }

  const send = () => {
    void (async () => {
      try {
        const fp = String(req.query.fingerprint ?? req.headers['x-device-fingerprint'] ?? '').trim()
        const row = await billing.getDeviceSubscriptionAccessState(deviceId, fp)
        const payload = toSsePayload(row)
        res.write(`event: snapshot\ndata: ${JSON.stringify(payload)}\n\n`)
      } catch (e) {
        console.error('[subscription-stream] snapshot failed:', e)
      }
    })()
  }
  send()

  const handler = async (payload) => {
    if (!payload || payload.deviceId !== deviceId) return
    try {
      const fp = String(req.query.fingerprint ?? req.headers['x-device-fingerprint'] ?? '').trim()
      const row = await billing.getDeviceSubscriptionAccessState(deviceId, fp)
      res.write(`event: device_subscription\ndata: ${JSON.stringify(toSsePayload(row))}\n\n`)
    } catch (e) {
      console.error('[subscription-stream] device_subscription event failed:', e)
    }
  }

  deviceSubscriptionBus.on('update', handler)

  const ping = setInterval(() => {
    res.write(': ping\n\n')
  }, 20_000)

  req.on('close', () => {
    clearInterval(ping)
    deviceSubscriptionBus.off('update', handler)
    try {
      res.end()
    } catch (e) {
      console.error('[subscription-stream] close res.end failed:', e)
    }
  })
})
