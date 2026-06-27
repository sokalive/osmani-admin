import { Router } from 'express'
import { resolveDevicePhoneProfile, saveDevicePhoneProfile, updateDevicePhoneProfile } from '../lib/devicePhoneProfile.js'
import { readPhoneGateEnabled } from '../lib/phoneGateSettings.js'

export const deviceProfileRouter = Router()

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? '')
    .split(',')[0]
    .trim()
}

async function phoneGatePayload(profile) {
  const gateEnabled = await readPhoneGateEnabled()
  return {
    phone_gate_enabled: gateEnabled,
    phoneGateEnabled: gateEnabled,
    phone_number_gate_enabled: gateEnabled,
    phoneNumberGateEnabled: gateEnabled,
    phone_gate_required: gateEnabled && !profile.hasPhone,
    phoneGateRequired: gateEnabled && !profile.hasPhone,
  }
}

function phoneResponse(result, gate) {
  return {
    ok: true,
    has_phone: true,
    hasPhone: true,
    phone_number: result.phoneNumber,
    phoneNumber: result.phoneNumber,
    phone_e164: result.phoneE164,
    phoneE164: result.phoneE164,
    registry: result.registry,
    ...gate,
  }
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
    const gate = await phoneGatePayload(profile)
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
      ...gate,
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
    const gate = await phoneGatePayload({ hasPhone: true })
    res.json(phoneResponse(result, gate))
  } catch (e) {
    console.error('[device/phone POST]', e)
    const msg = String(e.message || e)
    const status = msg.includes('required') || msg.includes('valid') ? 400 : 500
    res.status(status).json({ ok: false, error: msg })
  }
})

/** PUT /api/device/phone — update device phone (same validation as POST). */
deviceProfileRouter.put('/phone', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const result = await updateDevicePhoneProfile(body)
    const gate = await phoneGatePayload({ hasPhone: true })
    res.json(phoneResponse(result, gate))
  } catch (e) {
    console.error('[device/phone PUT]', e)
    const msg = String(e.message || e)
    const status = msg.includes('required') || msg.includes('valid') ? 400 : 500
    res.status(status).json({ ok: false, error: msg })
  }
})
