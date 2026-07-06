/**
 * Aggregated admin identity lookup — one bounded response for device ID or phone.
 */
import { getPool } from '../db/pool.js'
import { normalizePhoneDigits, tzPhoneCanonicalSql } from '../billingStore.js'

const MAX_DEVICES = 20
const MAX_TXNS_PER_DEVICE = 40
const MAX_GRANTS = 20
const MAX_REVOCATIONS = 20

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required.')
  return pool
}

function isExactDeviceId(q) {
  return /^[a-f0-9]{64}$/i.test(String(q ?? '').trim())
}

async function resolveDeviceIdsForPhone(pool, digits) {
  const { rows } = await pool.query(
    `SELECT DISTINCT d.device_id
     FROM (
       SELECT ds.device_id
       FROM device_subscriptions ds
       WHERE EXISTS (
         SELECT 1 FROM transactions t
         WHERE t.device_id = ds.device_id
           AND ${tzPhoneCanonicalSql('t.phone::text')} = $1
       )
       UNION
       SELECT device_id FROM device_phone_registry
       WHERE phone_number_normalized = $1
       UNION
       SELECT device_id FROM transactions
       WHERE ${tzPhoneCanonicalSql('phone::text')} = $1
         AND device_id IS NOT NULL AND trim(device_id) <> ''
     ) d
     WHERE d.device_id IS NOT NULL AND trim(d.device_id) <> ''
     LIMIT $2`,
    [digits, MAX_DEVICES],
  )
  return rows.map((r) => String(r.device_id))
}

async function fetchDeviceBundle(pool, deviceId) {
  const d = String(deviceId).trim()
  const [subRes, txnRes, grantRes, revokeRes, transferRes] = await Promise.all([
    pool.query(
      `SELECT ds.*, p.name AS plan_name
       FROM device_subscriptions ds
       LEFT JOIN plans p ON p.id = (
         SELECT t.plan_id FROM transactions t
         WHERE t.device_id = ds.device_id AND t.status = 'completed'
         ORDER BY t.created_at DESC LIMIT 1
       )
       WHERE ds.device_id = $1 LIMIT 1`,
      [d],
    ),
    pool.query(
      `SELECT order_id, device_id, phone, plan_id, amount, status, created_at, updated_at,
              raw_payload->>'payment_provider' AS payment_provider
       FROM transactions
       WHERE device_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [d, MAX_TXNS_PER_DEVICE],
    ),
    pool.query(
      `SELECT id, device_id, plan_id, created_by, manual_custom, created_at, expires_at_custom
       FROM manual_subscription_grants
       WHERE device_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT $2`,
      [d, MAX_GRANTS],
    ),
    pool.query(
      `SELECT id, device_id, admin_identity, reason, revoked_transaction_id, created_at
       FROM admin_subscription_revocation_actions
       WHERE device_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [d, MAX_REVOCATIONS],
    ),
    pool.query(
      `SELECT id, source_device_id, target_device_id, created_at, reason
       FROM device_transfers
       WHERE source_device_id = $1 OR target_device_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [d],
    ),
  ])

  const sub = subRes.rows[0] ?? null
  const phone =
    sub?.phone_number ??
    txnRes.rows.find((t) => t.phone)?.phone ??
    null

  return {
    device_id: d,
    subscription: sub,
    phone_number: phone,
    transactions: txnRes.rows,
    manual_grants: grantRes.rows,
    revocations: revokeRes.rows,
    transfers: transferRes.rows,
  }
}

/**
 * @returns {Promise<{ kind: string, query: string, normalized_phone?: string, devices: object[], ms?: number } | null>}
 */
export async function lookupAdminUserHistory(search) {
  const pool = requirePool()
  const q = String(search ?? '').trim()
  if (!q) return null
  const t0 = Date.now()

  let deviceIds = []
  let kind = 'partial'

  if (isExactDeviceId(q)) {
    kind = 'device'
    deviceIds = [q.toLowerCase()]
  } else {
    const digits = normalizePhoneDigits(q)
    if (digits && digits.length >= 9) {
      kind = 'phone'
      deviceIds = await resolveDeviceIdsForPhone(pool, digits)
    }
  }

  if (!deviceIds.length) return null

  const devices = await Promise.all(deviceIds.map((id) => fetchDeviceBundle(pool, id)))
  return {
    kind,
    query: q,
    normalized_phone: kind === 'phone' ? normalizePhoneDigits(q) : undefined,
    devices,
    ms: Date.now() - t0,
  }
}
