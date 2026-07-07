/**
 * Aggregated admin identity lookup — operational device rows only (phone = discovery).
 */
import { getPool } from '../db/pool.js'
import { normalizePhoneDigits, tzPhoneCanonicalSql } from '../billingStore.js'
import { getOperationalSubscriptionByDeviceId } from './adminUsersList.js'

const MAX_DEVICES = 50
const MAX_TXNS_PER_DEVICE = 40
const MAX_GRANTS = 20
const MAX_REVOCATIONS = 20

const SYNTHETIC_DEVICE_PREFIXES = [
  'direct-probe',
  'direct-proof',
  'verify-probe',
  'verify-proof',
  'verify-guard',
  'own-test',
  'immut_test',
  'ui-test',
  'probe-',
  'parity-',
  'audit-',
  'test-',
]

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required.')
  return pool
}

function isExactDeviceId(q) {
  return /^[a-f0-9]{64}$/i.test(String(q ?? '').trim())
}

/** Forensic / verification script IDs must not appear as operational subscription devices. */
export function isSyntheticForensicDeviceId(deviceId) {
  const s = String(deviceId ?? '').trim().toLowerCase()
  if (!s) return true
  return SYNTHETIC_DEVICE_PREFIXES.some((prefix) => s.startsWith(prefix))
}

/** Canonical production device identity for admin actions. */
export function isCanonicalOperationalDeviceId(deviceId) {
  const s = String(deviceId ?? '').trim()
  if (!s || isSyntheticForensicDeviceId(s)) return false
  return /^[a-f0-9]{64}$/i.test(s)
}

async function resolveDeviceIdsForPhone(pool, digits) {
  const { rows } = await pool.query(
    `SELECT DISTINCT trim(d.device_id) AS device_id
     FROM (
       SELECT ds.device_id::text AS device_id
       FROM device_subscriptions ds
       WHERE EXISTS (
         SELECT 1 FROM transactions t
         WHERE t.device_id = ds.device_id
           AND ${tzPhoneCanonicalSql('t.phone::text')} = $1
       )
       OR EXISTS (
         SELECT 1 FROM device_phone_registry dpr
         WHERE dpr.device_id::text = ds.device_id::text
           AND dpr.phone_number_normalized = $1
       )
       UNION
       SELECT trim(dpr.device_id::text) AS device_id
       FROM device_phone_registry dpr
       WHERE dpr.phone_number_normalized = $1
         AND trim(coalesce(dpr.device_id::text, '')) <> ''
       UNION
       SELECT trim(t.device_id::text) AS device_id
       FROM transactions t
       WHERE ${tzPhoneCanonicalSql('t.phone::text')} = $1
         AND t.status = 'completed'
         AND trim(coalesce(t.device_id::text, '')) <> ''
     ) d
     WHERE trim(coalesce(d.device_id, '')) <> ''
       AND length(trim(d.device_id)) = 64
       AND trim(d.device_id) ~ '^[a-f0-9]{64}$'
     ORDER BY device_id
     LIMIT $2`,
    [digits, MAX_DEVICES],
  )
  return rows
    .map((r) => String(r.device_id).trim().toLowerCase())
    .filter((id) => isCanonicalOperationalDeviceId(id))
}

async function deviceHasOperationalEvidence(pool, deviceId) {
  const d = String(deviceId).trim()
  const { rows } = await pool.query(
    `SELECT
       EXISTS (SELECT 1 FROM device_subscriptions ds WHERE ds.device_id = $1) AS has_subscription,
       EXISTS (
         SELECT 1 FROM transactions t
         WHERE t.device_id = $1 AND t.status = 'completed'
       ) AS has_completed_payment`,
    [d],
  )
  const r = rows[0] ?? {}
  return r.has_subscription === true || r.has_completed_payment === true
}

async function fetchOperationalDeviceBundle(pool, deviceId) {
  const d = String(deviceId).trim()
  const subscription = await getOperationalSubscriptionByDeviceId(d)
  if (!subscription && !(await deviceHasOperationalEvidence(pool, d))) return null

  const [txnRes, grantRes, revokeRes, transferRes] = await Promise.all([
    pool.query(
      `SELECT order_id, device_id, phone, plan_id, amount, status, created_at, updated_at,
              COALESCE(NULLIF(raw_payload->>'payment_provider',''), 'unknown') AS payment_provider
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

  const phone =
    subscription?.phone_number ||
    txnRes.rows.find((t) => t.phone)?.phone ||
    null

  return {
    device_id: d,
    subscription,
    phone_number: phone,
    transactions: txnRes.rows,
    manual_grants: grantRes.rows,
    revocations: revokeRes.rows,
    transfers: transferRes.rows,
    payment_count: txnRes.rows.length,
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
    const id = q.toLowerCase()
    if (isCanonicalOperationalDeviceId(id)) deviceIds = [id]
  } else {
    const digits = normalizePhoneDigits(q)
    if (digits && digits.length >= 9) {
      kind = 'phone'
      deviceIds = await resolveDeviceIdsForPhone(pool, digits)
    }
  }

  if (!deviceIds.length) return null

  const bundles = await Promise.all(deviceIds.map((id) => fetchOperationalDeviceBundle(pool, id)))
  const devices = bundles.filter(Boolean)
  if (!devices.length) return null

  return {
    kind,
    query: q,
    normalized_phone: kind === 'phone' ? normalizePhoneDigits(q) : undefined,
    devices,
    ms: Date.now() - t0,
  }
}
