import { getDeviceIntelligenceByDeviceId, registerDeviceIntelligence } from './deviceIntelligenceStore.js'
import { resolvePaymentPhoneForDevice } from '../billingStore.js'
import { normalizeInternationalPhone } from './internationalPhone.js'

function phoneDigitsFromStored(value) {
  const norm = normalizeInternationalPhone(value)
  return norm?.digits ?? ''
}

/**
 * Resolve whether this device already has a saved phone on the server.
 * @param {string} deviceId
 * @returns {Promise<{ hasPhone: boolean; phoneNumber: string; phoneE164: string; source: string | null }>}
 */
export async function resolveDevicePhoneProfile(deviceId) {
  const id = String(deviceId ?? '').trim()
  if (!id) {
    return { hasPhone: false, phoneNumber: '', phoneE164: '', source: null }
  }

  const registry = await getDeviceIntelligenceByDeviceId(id)
  let digits = phoneDigitsFromStored(registry?.phoneNumber)
  let source = digits ? 'device_registry' : null

  if (!digits) {
    const resolved = await resolvePaymentPhoneForDevice(id)
    digits = phoneDigitsFromStored(resolved?.phone)
    if (digits) source = resolved.source ?? 'subscription'
  }

  return {
    hasPhone: Boolean(digits),
    phoneNumber: digits,
    phoneE164: digits ? `+${digits}` : '',
    source,
  }
}

/**
 * Persist phone on device registry (creates row when missing).
 * @param {Record<string, unknown>} payload
 * @param {{ ip?: string; userAgent?: string }} [meta]
 */
export async function saveDevicePhoneProfile(payload, meta = {}) {
  const deviceId = String(payload.device_id ?? payload.deviceId ?? '').trim()
  if (!deviceId) throw new Error('device_id is required')

  const norm = normalizeInternationalPhone(payload.phone ?? payload.phone_number ?? payload.phoneNumber)
  if (!norm) throw new Error('phone must be a valid international number')

  const registry = await registerDeviceIntelligence(
    {
      ...payload,
      device_id: deviceId,
      phone: norm.digits,
      phone_number: norm.digits,
      phoneNumber: norm.digits,
      phone_e164: norm.e164,
      account_id: norm.digits,
    },
    meta,
  )

  return {
    ok: true,
    hasPhone: true,
    phoneNumber: norm.digits,
    phoneE164: norm.e164,
    registry,
  }
}
