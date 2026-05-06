import { Router } from 'express'
import * as billing from '../billingStore.js'
import { deviceSubscriptionBus } from '../lib/deviceSubscriptionBus.js'

export const subscriptionRouter = Router()

function rowToPublicStatus(row) {
  if (!row) return { active: false, status: null, expiresAt: null }
  const exp = row.expires_at
  const expDate = exp ? new Date(exp) : null
  const expiresOk =
    Boolean(expDate) && !Number.isNaN(expDate.getTime()) && expDate.getTime() > Date.now()
  const active = row.status === 'active' && expiresOk
  const expiresAt = exp instanceof Date ? exp.toISOString() : exp != null ? String(exp) : null
  return {
    active,
    /** legacy alias used by RN clients */
    isActive: active,
    status: row.status,
    expiresAt,
  }
}

/** GET /subscription-status — primary unlock check by device_id (poll every ~3s as fallback). */
subscriptionRouter.get('/subscription-status', async (req, res) => {
  try {
    const deviceId = String(req.query.device_id ?? '').trim()
    if (!deviceId) {
      return res.status(400).json({ error: 'device_id is required' })
    }
    const row = await billing.getDeviceSubscriptionByDeviceId(deviceId)
    res.json(rowToPublicStatus(row))
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
        const row = await billing.getDeviceSubscriptionByDeviceId(deviceId)
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
      const row = await billing.getDeviceSubscriptionByDeviceId(deviceId)
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
