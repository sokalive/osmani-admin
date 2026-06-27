import { getPool } from '../db/pool.js'
import { normalizePhoneInternational } from './phoneNormalize.js'

function cleanId(value) {
  return String(value ?? '').trim()
}

export async function getDevicePhoneRow(deviceId, installInstanceId = '') {
  const pool = getPool()
  const d = cleanId(deviceId)
  if (!d) return null
  const inst = cleanId(installInstanceId)
  const { rows } = await pool.query(
    `SELECT device_id, install_instance_id, phone_number_raw, phone_number_normalized,
            created_at, updated_at
     FROM device_phone_registry
     WHERE device_id = $1 AND install_instance_id = $2`,
    [d, inst],
  )
  return rows[0] ?? null
}

export async function getDevicePhoneStatus(deviceId, installInstanceId = '') {
  const row = await getDevicePhoneRow(deviceId, installInstanceId)
  if (!row) {
    return {
      hasPhone: false,
      phoneNumber: '',
      phoneNumberNormalized: '',
      installInstanceId: cleanId(installInstanceId),
      createdAt: null,
      updatedAt: null,
    }
  }
  return {
    hasPhone: Boolean(row.phone_number_normalized),
    phoneNumber: String(row.phone_number_raw ?? ''),
    phoneNumberNormalized: String(row.phone_number_normalized ?? ''),
    installInstanceId: String(row.install_instance_id ?? ''),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  }
}

/**
 * Save phone once — does not overwrite an existing different number.
 */
export async function saveDevicePhoneOnce({ deviceId, installInstanceId = '', phone }) {
  const d = cleanId(deviceId)
  if (!d) throw new Error('device_id is required')
  const inst = cleanId(installInstanceId)
  const parsed = normalizePhoneInternational(phone)
  if (!parsed.valid) throw new Error(parsed.error || 'invalid phone')

  const existing = await getDevicePhoneRow(d, inst)
  if (existing) {
    if (existing.phone_number_normalized === parsed.normalized) {
      return { saved: false, reason: 'unchanged', row: existing }
    }
    return { saved: false, reason: 'already_exists', row: existing }
  }

  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO device_phone_registry (
       device_id, install_instance_id, phone_number_raw, phone_number_normalized, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, now(), now())
     RETURNING *`,
    [d, inst, parsed.raw, parsed.normalized],
  )
  return { saved: true, reason: 'created', row: rows[0] }
}

/** Intentional update — replaces stored phone for device+install. */
export async function updateDevicePhone({ deviceId, installInstanceId = '', phone }) {
  const d = cleanId(deviceId)
  if (!d) throw new Error('device_id is required')
  const inst = cleanId(installInstanceId)
  const parsed = normalizePhoneInternational(phone)
  if (!parsed.valid) throw new Error(parsed.error || 'invalid phone')

  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO device_phone_registry (
       device_id, install_instance_id, phone_number_raw, phone_number_normalized, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, now(), now())
     ON CONFLICT (device_id, install_instance_id) DO UPDATE SET
       phone_number_raw = EXCLUDED.phone_number_raw,
       phone_number_normalized = EXCLUDED.phone_number_normalized,
       updated_at = now()
     RETURNING *`,
    [d, inst, parsed.raw, parsed.normalized],
  )
  return { saved: true, reason: 'updated', row: rows[0] }
}

/** Best saved phone for SMS — prefers exact install match, then any install for device. */
export async function resolveSavedDevicePhone(deviceId, installInstanceId = '') {
  const d = cleanId(deviceId)
  if (!d) return { phone: '', normalized: '', source: null }
  const inst = cleanId(installInstanceId)
  if (inst) {
    const exact = await getDevicePhoneRow(d, inst)
    if (exact?.phone_number_normalized) {
      return {
        phone: String(exact.phone_number_raw ?? exact.phone_number_normalized),
        normalized: String(exact.phone_number_normalized),
        source: 'device_phone_registry',
      }
    }
  }
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT phone_number_raw, phone_number_normalized
     FROM device_phone_registry
     WHERE device_id = $1 AND phone_number_normalized <> ''
     ORDER BY updated_at DESC
     LIMIT 1`,
    [d],
  )
  if (rows[0]?.phone_number_normalized) {
    return {
      phone: String(rows[0].phone_number_raw ?? rows[0].phone_number_normalized),
      normalized: String(rows[0].phone_number_normalized),
      source: 'device_phone_registry',
    }
  }
  return { phone: '', normalized: '', source: null }
}
