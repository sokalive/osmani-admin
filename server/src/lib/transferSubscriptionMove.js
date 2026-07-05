/**
 * Atomic subscription move for user transfer + admin force transfer.
 * Preserves the longer of source/target expiry when target already has active entitlement.
 */
import { notifySubscriptionTransferred } from './subscriptionTransferNotify.js'
import { liveSyncBus } from './liveSyncBus.js'
import { deviceSubscriptionBus } from './deviceSubscriptionBus.js'

function emitSync(event, payload) {
  liveSyncBus.publish(event, { topics: ['config', 'analytics'], ...payload })
}

/**
 * @param {Date | string | null | undefined} sourceExpiresAt
 * @param {Date | string | null | undefined} targetExistingExpiresAt
 * @param {Date} [now]
 */
export function computeTransferTargetExpiry(sourceExpiresAt, targetExistingExpiresAt, now = new Date()) {
  const srcMs = sourceExpiresAt ? new Date(sourceExpiresAt).getTime() : 0
  if (!Number.isFinite(srcMs) || srcMs <= now.getTime()) return null
  const tgtMs = targetExistingExpiresAt ? new Date(targetExistingExpiresAt).getTime() : 0
  if (Number.isFinite(tgtMs) && tgtMs > now.getTime() && tgtMs > srcMs) {
    return new Date(tgtMs)
  }
  return new Date(srcMs)
}

/**
 * @param {import('pg').PoolClient} client
 * @param {{
 *   sourceDeviceId: string,
 *   targetDeviceId: string,
 *   targetFpHash?: string | null,
 *   code: string,
 *   transactionPrefix?: string,
 *   transferReason?: string,
 *   notifyReason?: string,
 *   userInitiatedTransfer?: boolean,
 * }} opts
 */
export async function commitSubscriptionTransfer(client, opts) {
  const src = String(opts.sourceDeviceId ?? '').trim()
  const tgt = String(opts.targetDeviceId ?? '').trim()
  const code = String(opts.code ?? '').trim()
  const targetFpHash = opts.targetFpHash ?? null
  const txnId = `${opts.transactionPrefix || 'transfer'}:${code}`
  if (!src || !tgt || src === tgt) {
    return { ok: false, status: 400, error: 'Invalid source or target device' }
  }

  const sourceSub = await client.query(`SELECT * FROM device_subscriptions WHERE device_id = $1 FOR UPDATE`, [src])
  const sub = sourceSub.rows[0]
  if (!sub) return { ok: false, status: 404, error: 'Source subscription not found' }

  const validSubRes = await client.query(
    `SELECT (status = 'active' AND expires_at > now()) AS active FROM device_subscriptions WHERE device_id = $1`,
    [src],
  )
  if (!validSubRes.rows[0]?.active) {
    return { ok: false, status: 400, error: 'Source subscription expired' }
  }

  const targetExisting = await client.query(
    `SELECT device_id, status, expires_at FROM device_subscriptions WHERE device_id = $1 FOR UPDATE`,
    [tgt],
  )
  const targetRow = targetExisting.rows[0]
  const targetExpiry = computeTransferTargetExpiry(sub.expires_at, targetRow?.expires_at)
  if (!targetExpiry) return { ok: false, status: 400, error: 'Source subscription expired' }

  const upsertTarget = await client.query(
    `INSERT INTO device_subscriptions (device_id, status, expires_at, started_at, transaction_id, updated_at, fingerprint_hash)
     VALUES ($1, 'active', $2, $3, $4, now(), $5)
     ON CONFLICT (device_id) DO UPDATE SET
       status = 'active',
       expires_at = EXCLUDED.expires_at,
       started_at = COALESCE(device_subscriptions.started_at, EXCLUDED.started_at),
       transaction_id = EXCLUDED.transaction_id,
       updated_at = now(),
       fingerprint_hash = COALESCE(EXCLUDED.fingerprint_hash, device_subscriptions.fingerprint_hash)
     RETURNING device_id, status, expires_at, started_at, transaction_id`,
    [tgt, targetExpiry, sub.started_at ?? new Date(), txnId, targetFpHash],
  )
  if (!upsertTarget.rows[0]) {
    return { ok: false, status: 500, error: 'Target subscription activation failed' }
  }

  const revokeSource = await client.query(
    `UPDATE device_subscriptions SET status = 'pending', updated_at = now()
     WHERE device_id = $1
     RETURNING device_id, status, expires_at`,
    [src],
  )
  if (!revokeSource.rows[0]) {
    return { ok: false, status: 500, error: 'Source subscription revoke failed' }
  }

  const postState = await client.query(
    `SELECT device_id, status, expires_at, (status = 'active' AND expires_at > now()) AS active_now
     FROM device_subscriptions WHERE device_id = ANY($1::text[])`,
    [[src, tgt]],
  )
  const sourceAfter = postState.rows.find((r) => String(r.device_id) === src)
  const targetAfter = postState.rows.find((r) => String(r.device_id) === tgt)
  if (!targetAfter?.active_now) {
    return { ok: false, status: 500, error: 'Transfer verification failed: target is not active after move' }
  }
  if (sourceAfter?.active_now) {
    return { ok: false, status: 500, error: 'Transfer verification failed: source still active after revoke' }
  }

  return {
    ok: true,
    sourceDeviceId: src,
    targetDeviceId: tgt,
    expiresAt: targetAfter.expires_at,
    sourceAfter,
    targetAfter,
    transferReason: opts.transferReason || 'confirmed_by_code',
    notifyReason: opts.notifyReason || 'transfer_confirm',
    userInitiatedTransfer: opts.userInitiatedTransfer !== false,
  }
}

export function publishTransferRealtime({
  sourceDeviceId,
  targetDeviceId,
  sourceAfter,
  targetAfter,
  reason = 'transfer_confirm',
  userInitiatedTransfer = true,
  syncReason = 'confirmed_by_code',
}) {
  notifySubscriptionTransferred({
    sourceDeviceId,
    targetDeviceId,
    sourceRow: sourceAfter,
    targetRow: targetAfter,
    reason,
    userInitiatedTransfer,
  })
  emitSync('transfer_completed', {
    source_device_id: sourceDeviceId,
    target_device_id: targetDeviceId,
    reason: syncReason,
  })
  emitSync('subscription_revoked', { device_id: sourceDeviceId, reason: syncReason })
  emitSync('transfer_codes_changed', {
    action: 'confirm',
    source_device_id: sourceDeviceId,
    target_device_id: targetDeviceId,
  })
  emitSync('security_logs_changed', {
    action: 'transfer_confirm',
    source_device_id: sourceDeviceId,
    target_device_id: targetDeviceId,
  })
}

export function publishTransferConfirmationRequired({
  sourceDeviceId,
  targetDeviceId,
  code,
  transferId,
  expiresAt,
}) {
  deviceSubscriptionBus.emit('update', {
    deviceId: sourceDeviceId,
    reason: 'transfer_confirmation_required',
    code,
    transferId,
    targetDeviceId,
    expiresAt,
  })
  emitSync('transfer_confirmation_required', {
    source_device_id: sourceDeviceId,
    target_device_id: targetDeviceId,
    code,
    transfer_id: transferId,
    expires_at: expiresAt,
  })
}
