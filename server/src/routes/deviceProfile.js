import { Router } from 'express'
import { resolveDevicePhoneProfile, saveDevicePhoneProfile } from '../lib/devicePhoneProfile.js'

export const deviceProfileRouter = Router()

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? '')
    .split(',')[0]
    .trim()
}

/** GET /api/device/profile — phone capture gate status for this device. */
deviceProfileRouter.get('/profile', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
    const deviceId = String(req.query.device_id ?? req.query.deviceId ?? '').trim()
    if (!deviceId) {
      return res.status(400).json({ ok: false, error: 'device_id is required' })
    }
    const profile = await resolveDevicePhoneProfile(deviceId)
    res.json({
      ok: true,
      has_phone: profile.hasPhone,
      hasPhone: profile.hasPhone,
      phone_number: profile.phoneNumber,
      phoneNumber: profile.phoneNumber,
      phone_e164: profile.phoneE164,
      phoneE164: profile.phoneE164,
      source: profile.source,
      install_instance_id: String(req.query.install_instance_id ?? req.query.installInstanceId ?? '').trim() || null,
    })
  } catch (e) {
    console.error('[device/profile]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** POST /api/device/phone — save mandatory device phone (no OTP). */
deviceProfileRouter.post('/phone', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const result = await saveDevicePhoneProfile(body, {
      ip: clientIp(req),
      userAgent: String(req.headers['user-agent'] ?? ''),
    })
    res.json({
      ok: true,
      has_phone: true,
      hasPhone: true,
      phone_number: result.phoneNumber,
      phoneNumber: result.phoneNumber,
      phone_e164: result.phoneE164,
      phoneE164: result.phoneE164,
      registry: result.registry,
    })
  } catch (e) {
    console.error('[device/phone]', e)
    const msg = String(e.message || e)
    const status = msg.includes('required') || msg.includes('valid') ? 400 : 500
    res.status(status).json({ ok: false, error: msg })
  }
})
