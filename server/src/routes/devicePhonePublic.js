import { Router } from 'express'
import {
  getDevicePhoneStatus,
  saveDevicePhoneOnce,
  updateDevicePhone,
} from '../lib/devicePhoneStore.js'

export const devicePhonePublicRouter = Router()

function readIds(req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {}
  const deviceId = String(
    req.query.device_id ?? req.query.deviceId ?? body.device_id ?? body.deviceId ?? '',
  ).trim()
  const installInstanceId = String(
    req.query.install_instance_id ??
      req.query.installInstanceId ??
      body.install_instance_id ??
      body.installInstanceId ??
      '',
  ).trim()
  return { deviceId, installInstanceId }
}

devicePhonePublicRouter.get('/status', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
    const { deviceId, installInstanceId } = readIds(req)
    if (!deviceId) {
      return res.status(400).json({ ok: false, error: 'device_id is required' })
    }
    const status = await getDevicePhoneStatus(deviceId, installInstanceId)
    res.json({ ok: true, ...status })
  } catch (e) {
    console.error('[device-phone] GET /status failed:', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Save phone once — rejects overwrite unless unchanged. */
devicePhonePublicRouter.post('/', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
    const { deviceId, installInstanceId } = readIds(req)
    const phone = String(req.body?.phone ?? req.body?.phone_number ?? req.body?.phoneNumber ?? '').trim()
    if (!deviceId) return res.status(400).json({ ok: false, error: 'device_id is required' })
    if (!phone) return res.status(400).json({ ok: false, error: 'phone is required' })

    const result = await saveDevicePhoneOnce({ deviceId, installInstanceId, phone })
    const status = await getDevicePhoneStatus(deviceId, installInstanceId)
    res.json({
      ok: true,
      saved: result.saved === true,
      reason: result.reason,
      ...status,
    })
  } catch (e) {
    console.error('[device-phone] POST failed:', e)
    const msg = String(e.message || e)
    res.status(msg.includes('invalid') || msg.includes('required') ? 400 : 500).json({
      ok: false,
      error: msg,
    })
  }
})

/** Intentional update of saved phone. */
devicePhonePublicRouter.put('/', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
    const { deviceId, installInstanceId } = readIds(req)
    const phone = String(req.body?.phone ?? req.body?.phone_number ?? req.body?.phoneNumber ?? '').trim()
    if (!deviceId) return res.status(400).json({ ok: false, error: 'device_id is required' })
    if (!phone) return res.status(400).json({ ok: false, error: 'phone is required' })

    await updateDevicePhone({ deviceId, installInstanceId, phone })
    const status = await getDevicePhoneStatus(deviceId, installInstanceId)
    res.json({ ok: true, saved: true, reason: 'updated', ...status })
  } catch (e) {
    console.error('[device-phone] PUT failed:', e)
    const msg = String(e.message || e)
    res.status(msg.includes('invalid') || msg.includes('required') ? 400 : 500).json({
      ok: false,
      error: msg,
    })
  }
})
