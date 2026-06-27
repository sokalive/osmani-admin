/**
 * Immediate cache + realtime notification when subscription moves between devices.
 */
import { deviceSubscriptionBus } from './deviceSubscriptionBus.js'
import { liveSyncBus } from './liveSyncBus.js'
import {
  invalidateSubscriptionAccessCache,
  setCachedSubscriptionAccess,
} from './subscriptionAccessCache.js'
import { clearVerifyAccessInflightForDevice } from './verifyAccessSingleflight.js'

function toAccessCacheRow(dbRow, deviceId) {
  if (!dbRow) return null
  const status = String(dbRow.status ?? 'pending')
  const active_now =
    dbRow.active_now === true && status === 'active' && dbRow.blocked_now !== true
  return {
    device_id: String(dbRow.device_id ?? deviceId ?? ''),
    status,
    expires_at: dbRow.expires_at ?? null,
    started_at: dbRow.started_at ?? null,
    updated_at: dbRow.updated_at ?? null,
    transaction_id: dbRow.transaction_id ?? null,
    active_now,
    blocked_now: dbRow.blocked_now === true,
    block_reason: dbRow.block_reason ?? null,
    remaining_seconds: active_now ? Number(dbRow.remaining_seconds) || 0 : 0,
    remaining_hours: active_now ? Number(dbRow.remaining_hours) || 0 : 0,
    remaining_days: active_now ? Number(dbRow.remaining_days) || 0 : 0,
    near_expiry: active_now ? dbRow.near_expiry === true : false,
  }
}

function primeDeviceCache(deviceId, dbRow) {
  const d = String(deviceId ?? '').trim()
  if (!d) return
  invalidateSubscriptionAccessCache(d)
  clearVerifyAccessInflightForDevice(d)
  const row = toAccessCacheRow(dbRow, d)
  setCachedSubscriptionAccess(d, '', row)
}

function publishDeviceSubscriptionUpdate(deviceId, reason) {
  const d = String(deviceId ?? '').trim()
  if (!d) return
  deviceSubscriptionBus.emit('update', { deviceId: d, reason })
  liveSyncBus.publish('analytics.subscription_updated', {
    topics: ['analytics'],
    deviceId: d,
    reason,
  })
}

/**
 * Call immediately after transfer/recovery commits source revoke + target activation.
 */
const USER_INITIATED_TRANSFER_REASONS = new Set([
  'transfer',
  'transfer_confirm',
  'admin_force_transfer',
  'transfer_repair',
])

function isUserInitiatedTransferReason(reason, userInitiatedTransfer) {
  if (userInitiatedTransfer === true) return true
  if (userInitiatedTransfer === false) return false
  const r = String(reason ?? '').trim()
  return USER_INITIATED_TRANSFER_REASONS.has(r) || r.startsWith('transfer_')
}

export function notifySubscriptionTransferred({
  sourceDeviceId,
  targetDeviceId,
  sourceRow,
  targetRow,
  reason = 'transfer',
  userInitiatedTransfer,
} = {}) {
  const src = String(sourceDeviceId ?? '').trim()
  const tgt = String(targetDeviceId ?? '').trim()
  const userTransfer = isUserInitiatedTransferReason(reason, userInitiatedTransfer)

  if (src && sourceRow) primeDeviceCache(src, sourceRow)
  else if (src) {
    invalidateSubscriptionAccessCache(src)
    clearVerifyAccessInflightForDevice(src)
  }

  if (tgt && targetRow) primeDeviceCache(tgt, targetRow)
  else if (tgt) {
    invalidateSubscriptionAccessCache(tgt)
    clearVerifyAccessInflightForDevice(tgt)
  }

  // Only user-initiated transfers emit *_revoked on source (avoids false "package transferred" UI).
  if (src && userTransfer) publishDeviceSubscriptionUpdate(src, `${reason}_revoked`)
  else if (src) publishDeviceSubscriptionUpdate(src, 'access_sync')

  if (tgt) {
    publishDeviceSubscriptionUpdate(tgt, userTransfer ? `${reason}_active` : 'access_sync_active')
  }
}

export { toAccessCacheRow }
