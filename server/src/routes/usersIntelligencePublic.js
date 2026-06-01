import { Router } from 'express'
import {
  getDeviceIntelligenceByDeviceId,
  registerDeviceIntelligence,
} from '../lib/deviceIntelligenceStore.js'

export const usersIntelligencePublicRouter = Router()

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? '').split(',')[0].trim()
}

async function handleRegister(req, res) {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const registry = await registerDeviceIntelligence(body, {
      ip: clientIp(req),
      userAgent: String(req.headers['user-agent'] ?? ''),
    })
    res.json({
      ok: true,
      registry,
      blocked: registry.blocked === true,
      allowed: registry.allowed !== false,
    })
  } catch (e) {
    console.error('[users-intelligence/register]', e)
    const msg = String(e.message || e)
    const status = msg.includes('required') ? 400 : 500
    res.status(status).json({ ok: false, error: msg })
  }
}

/** Android app: register or refresh device on launch (additive endpoint). */
usersIntelligencePublicRouter.post('/register', handleRegister)
usersIntelligencePublicRouter.post('/register-device', handleRegister)

/** Lightweight poll: is this device blocked by Users Intelligence? */
usersIntelligencePublicRouter.get('/access-check', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
    const deviceId = String(req.query.device_id ?? req.query.deviceId ?? '').trim()
    if (!deviceId) {
      return res.status(400).json({ ok: false, error: 'device_id is required' })
    }
    const registry = await getDeviceIntelligenceByDeviceId(deviceId)
    if (!registry) {
      return res.json({ ok: true, registered: false, blocked: false, allowed: true, status: null })
    }
    res.json({
      ok: true,
      registered: true,
      blocked: registry.status === 'blocked',
      allowed: registry.status !== 'blocked',
      status: registry.status,
      blockReason: registry.blockReason || '',
    })
  } catch (e) {
    console.error('[users-intelligence/access-check]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})
