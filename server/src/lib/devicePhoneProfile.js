import { resolvePaymentPhoneForDevice } from '../billingStore.js'
import {
  getDevicePhoneStatus,
  resolveSavedDevicePhone,
  saveDevicePhoneOnce,
  updateDevicePhone,
} from './devicePhoneStore.js'
import { normalizePhoneInternational } from './phoneNormalize.js'

function profileFromNormalized({ normalized, raw, source }) {
  const digits = String(normalized ?? '').trim()
  return {
    hasPhone: Boolean(digits),
    phoneNumber: digits,
    phoneE164: digits ? `+${digits}` : '',
    source: source || null,
    phoneRaw: String(raw ?? ''),
  }
}

/**
 * Resolve whether this device already has a saved phone on the server.
 */
export async function resolveDevicePhoneProfile(deviceId, installInstanceId = '') {
  const id = String(deviceId ?? '').trim()
  if (!id) {
    return { hasPhone: false, phoneNumber: '', phoneE164: '', source: null }
  }

  const saved = await resolveSavedDevicePhone(id, installInstanceId)
  if (saved.normalized) {
    return profileFromNormalized({
      normalized: saved.normalized,
      raw: saved.phone,
      source: saved.source,
    })
  }

  const resolved = await resolvePaymentPhoneForDevice(id)
  const parsed = normalizePhoneInternational(resolved?.phone ?? '')
  if (parsed.valid) {
    return profileFromNormalized({
      normalized: parsed.normalized,
      raw: parsed.raw,
      source: resolved.source ?? 'subscription',
    })
  }

  return { hasPhone: false, phoneNumber: '', phoneE164: '', source: null }
}

/**
 * Persist phone on device_phone_registry (save once; use update endpoint to change).
 */
export async function saveDevicePhoneProfile(payload, _meta = {}) {
  const deviceId = String(payload.device_id ?? payload.deviceId ?? '').trim()
  if (!deviceId) throw new Error('device_id is required')
  const installInstanceId = String(
    payload.install_instance_id ?? payload.installInstanceId ?? '',
  ).trim()
  const phone = payload.phone ?? payload.phone_number ?? payload.phoneNumber
  const parsed = normalizePhoneInternational(phone)
  if (!parsed.valid) throw new Error(parsed.error || 'phone must be a valid international number')

  const existing = await getDevicePhoneStatus(deviceId, installInstanceId)
  let result
  if (existing.hasPhone) {
    if (existing.phoneNumberNormalized === parsed.normalized) {
      result = { saved: false, reason: 'unchanged' }
    } else {
      throw new Error('phone already saved for this device')
    }
  } else {
    result = await saveDevicePhoneOnce({ deviceId, installInstanceId, phone: parsed.raw })
  }

  return {
    ok: true,
    hasPhone: true,
    phoneNumber: parsed.normalized,
    phoneE164: `+${parsed.normalized}`,
    registry: result,
  }
}

/** Intentional phone update for app clients that support re-save. */
export async function updateDevicePhoneProfile(payload) {
  const deviceId = String(payload.device_id ?? payload.deviceId ?? '').trim()
  if (!deviceId) throw new Error('device_id is required')
  const installInstanceId = String(
    payload.install_instance_id ?? payload.installInstanceId ?? '',
  ).trim()
  const phone = payload.phone ?? payload.phone_number ?? payload.phoneNumber
  const parsed = normalizePhoneInternational(phone)
  if (!parsed.valid) throw new Error(parsed.error || 'phone must be a valid international number')

  await updateDevicePhone({ deviceId, installInstanceId, phone: parsed.raw })
  return {
    ok: true,
    hasPhone: true,
    phoneNumber: parsed.normalized,
    phoneE164: `+${parsed.normalized}`,
  }
}
