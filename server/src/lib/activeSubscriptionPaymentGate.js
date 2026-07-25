/**
 * Device-active payment gate — permanently blocks checkout while entitlement is active.
 * Phone is never used; stacking renewals are not allowed.
 */
import { getPool } from '../db/pool.js'

export const ACTIVE_SUBSCRIPTION_EXISTS = 'ACTIVE_SUBSCRIPTION_EXISTS'

export const ACTIVE_SUBSCRIPTION_EXISTS_MESSAGE_SW =
  'Kifaa hiki tayari kina kifurushi kinachoendelea. Subiri kiishe kabla ya kununua tena.'

export const ACTIVE_SUBSCRIPTION_EXISTS_MESSAGE =
  'This device already has an active subscription. Wait until it expires before purchasing again.'

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required.')
  return pool
}

function migrationRevokedSql(alias = 'ds') {
  return `COALESCE(${alias}.transaction_id::text, '') NOT LIKE 'moved:%'`
}

function notCompletedTransferSourceSql(alias = 'ds') {
  return `NOT EXISTS (
    SELECT 1 FROM device_transfers dt
    WHERE dt.status = 'completed'
      AND dt.source_device_id::text = ${alias}.device_id::text
  )`
}

/**
 * @returns {Promise<{ blocked: boolean, code?: string, deviceId?: string, expiresAt?: string|null, remainingDays?: number, status?: string|null, transactionId?: string|null }>}
 */
export async function getActiveDeviceSubscriptionBlock(deviceId) {
  const d = String(deviceId ?? '').trim()
  if (!d) return { blocked: false }
  const pool = requirePool()
  const { rows } = await pool.query(
    `SELECT
       ds.device_id::text AS device_id,
       ds.status,
       ds.expires_at,
       ds.transaction_id,
       GREATEST(
         0,
         (
           (ds.expires_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date
           - (now() AT TIME ZONE 'Africa/Dar_es_Salaam')::date
         )
       )::int AS remaining_days_eat
     FROM device_subscriptions ds
     WHERE ds.device_id = $1
       AND ds.expires_at > now()
       AND LOWER(COALESCE(NULLIF(trim(ds.status::text), ''), 'active')) = 'active'
       AND COALESCE(ds.manual_admin_blocked, false) = false
       AND ds.admin_revoked_at IS NULL
       AND ${migrationRevokedSql('ds')}
       AND ${notCompletedTransferSourceSql('ds')}
     LIMIT 1`,
    [d],
  )
  const row = rows[0]
  if (!row) return { blocked: false }
  const expiresAt =
    row.expires_at instanceof Date
      ? row.expires_at.toISOString()
      : row.expires_at != null
        ? String(row.expires_at)
        : null
  return {
    blocked: true,
    code: ACTIVE_SUBSCRIPTION_EXISTS,
    deviceId: String(row.device_id ?? d),
    expiresAt,
    remainingDays: Number(row.remaining_days_eat) || 0,
    status: row.status != null ? String(row.status) : 'active',
    transactionId: row.transaction_id != null ? String(row.transaction_id) : null,
  }
}

export async function assertNoActiveSubscriptionForPayment(deviceId) {
  const block = await getActiveDeviceSubscriptionBlock(deviceId)
  return { ok: !block.blocked, ...block }
}

export function activeSubscriptionExistsHttpBody(block) {
  return {
    success: false,
    ok: false,
    code: ACTIVE_SUBSCRIPTION_EXISTS,
    error: ACTIVE_SUBSCRIPTION_EXISTS,
    message: ACTIVE_SUBSCRIPTION_EXISTS_MESSAGE,
    message_sw: ACTIVE_SUBSCRIPTION_EXISTS_MESSAGE_SW,
    device_id: block.deviceId ?? null,
    expires_at: block.expiresAt ?? null,
    remaining_days: block.remainingDays ?? 0,
    reason: 'active_subscription_exists',
  }
}
