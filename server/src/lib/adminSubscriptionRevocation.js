/**
 * Explicit admin subscription revocation — preserves payment history, blocks old-order replay.
 */
import { getPool } from '../db/pool.js'
import { invalidateSubscriptionAccessCache } from './subscriptionAccessCache.js'
import { deviceSubscriptionBus } from './deviceSubscriptionBus.js'
import { liveSyncBus } from './liveSyncBus.js'

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  return pool
}

export async function getAdminRevocationState(deviceId, client = null) {
  const pool = requirePool()
  const q = client ? client.query.bind(client) : pool.query.bind(pool)
  const d = String(deviceId ?? '').trim()
  if (!d) return null
  const { rows } = await q(
    `SELECT device_id, status, transaction_id, admin_revoked_at, admin_revoked_transaction_id
     FROM device_subscriptions WHERE device_id = $1 LIMIT 1`,
    [d],
  )
  return rows[0] ?? null
}

/** Block replay of the same completed order after intentional admin revocation. New orders may activate. */
export function isAdminRevokedOrderBlocked(revocationRow, orderId) {
  if (!revocationRow?.admin_revoked_at) return false
  const revokedTxn = String(revocationRow.admin_revoked_transaction_id ?? revocationRow.transaction_id ?? '').trim()
  const oid = String(orderId ?? '').trim()
  if (!revokedTxn || !oid) return Boolean(revocationRow.admin_revoked_at)
  return oid === revokedTxn
}

/**
 * Revoke entitlement for exact device — keeps device_subscriptions row + all transactions.
 */
export async function revokeAdminDeviceSubscription({
  deviceId,
  adminIdentity = 'admin',
  reason = '',
  client = null,
}) {
  const pool = requirePool()
  const d = String(deviceId ?? '').trim()
  if (!d) throw new Error('device_id is required')

  const run = client ? client.query.bind(client) : pool.query.bind(pool)
  const { rows: existing } = await run(`SELECT * FROM device_subscriptions WHERE device_id = $1 FOR UPDATE`, [d])
  const row = existing[0]
  if (!row) return { ok: false, notFound: true, deviceId: d }

  const txnId = String(row.transaction_id ?? '').trim()
  const alreadyRevoked =
    String(row.status ?? '').toLowerCase() === 'revoked' && row.admin_revoked_at != null

  if (alreadyRevoked) {
    return {
      ok: true,
      idempotent: true,
      deviceId: d,
      revoked: false,
      alreadyRevoked: true,
      transaction_id: txnId,
    }
  }

  const { rows } = await run(
    `UPDATE device_subscriptions SET
       status = 'revoked',
       admin_revoked_at = now(),
       admin_revoked_by = $2,
       admin_revocation_reason = $3,
       admin_revoked_transaction_id = COALESCE(NULLIF($4, ''), transaction_id),
       manual_admin_blocked = false,
       updated_at = now()
     WHERE device_id = $1
     RETURNING *`,
    [d, String(adminIdentity).slice(0, 256), String(reason ?? '').slice(0, 2000), txnId],
  )

  invalidateSubscriptionAccessCache(d)

  return {
    ok: true,
    idempotent: false,
    deviceId: d,
    revoked: true,
    alreadyRevoked: false,
    subscription: rows[0] ?? null,
    transaction_id: txnId,
  }
}

export async function insertAdminRevocationAudit(client, { deviceId, adminIdentity, reason, transactionId }) {
  await client.query(
    `INSERT INTO admin_subscription_revocation_actions (
       device_id, admin_identity, reason, revoked_transaction_id
     ) VALUES ($1, $2, $3, $4)`,
    [
      String(deviceId).slice(0, 128),
      String(adminIdentity).slice(0, 256),
      String(reason ?? '').slice(0, 2000),
      String(transactionId ?? '').slice(0, 256) || null,
    ],
  )
}

/** Post-commit realtime fan-out for admin revocation (cross-process via liveSync + deviceSubscription relay). */
export function notifyAdminSubscriptionRevoked(deviceId, orderId = 'admin_revoke') {
  const d = String(deviceId ?? '').trim()
  if (!d) return
  invalidateSubscriptionAccessCache(d)
  deviceSubscriptionBus.emit('update', { deviceId: d, reason: 'admin_revoked', adminRevoked: true })
  liveSyncBus.publish('analytics.subscription_updated', {
    topics: ['analytics'],
    deviceId: d,
    orderId: String(orderId),
    reason: 'admin_revoke',
  })
  liveSyncBus.publish('subscription_revoked', {
    topics: ['config'],
    device_id: d,
    deviceId: d,
    reason: 'admin_revoked',
    inactive_reason: 'admin_revoked',
    suppress_expiry_popup: true,
    synced_at: new Date().toISOString(),
  })
}
