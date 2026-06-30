/**
 * Resolve package name + price for subscription lifecycle SMS (expiry / expired).
 */
import {
  getLatestCompletedTransactionForDevice,
  getLatestManualSubscriptionGrantRecord,
  getPlanRowByIdAny,
  getTransactionByOrderId,
} from '../billingStore.js'
import { getPool } from '../db/pool.js'

/** Extract underlying payment order id from synthetic device_subscriptions.transaction_id. */
export function extractPaymentOrderIdFromSubscriptionTxn(transactionId) {
  const t = String(transactionId ?? '').trim()
  if (!t) return ''
  if (/^manual_grant:\d+$/i.test(t)) return t
  const moved = /^moved:[^:]+:(.+)$/i.exec(t)
  if (moved) return String(moved[1] ?? '').trim()
  if (/^(transfer|recovery|force|repair):/i.test(t)) return ''
  return t
}

async function planByDurationDays(durationDays) {
  const n = Math.trunc(Number(durationDays))
  if (!Number.isFinite(n) || n < 1) return null
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT id, name, price, duration_days
     FROM plans
     WHERE deleted_at IS NULL
       AND is_active = true
       AND expiry_type <> 'fixed'
       AND duration_days = $1
     ORDER BY id ASC
     LIMIT 1`,
    [n],
  )
  return rows[0] ?? null
}

async function packageFromTransactionOrderId(orderId) {
  const oid = String(orderId ?? '').trim()
  if (!oid) return null

  if (/^manual_grant:(\d+)$/i.test(oid)) {
    const grantId = Number(oid.slice('manual_grant:'.length))
    if (!Number.isSafeInteger(grantId) || grantId < 1) return null
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT id, duration_days, plan_id FROM manual_subscription_grants
       WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
      [grantId],
    )
    const grant = rows[0]
    if (!grant) return null
    if (grant.plan_id != null) {
      const plan = await getPlanRowByIdAny(grant.plan_id)
      if (plan) {
        return {
          planName: String(plan.name ?? ''),
          price: plan.price != null ? Number(plan.price) : null,
          currency: 'TZS',
          source: 'manual_grant',
        }
      }
    }
    const plan = await planByDurationDays(grant.duration_days)
    return {
      planName: plan?.name ? String(plan.name) : '',
      price: plan?.price != null ? Number(plan.price) : null,
      currency: 'TZS',
      source: 'manual_grant',
    }
  }

  const txn = await getTransactionByOrderId(oid)
  if (!txn) return null
  const plan = txn.plan_id != null ? await getPlanRowByIdAny(txn.plan_id) : null
  const planName = String(plan?.name ?? txn.plan_name ?? '').trim()
  const price =
    txn.amount != null
      ? Number(txn.amount)
      : plan?.price != null
        ? Number(plan.price)
        : null
  return {
    planName,
    price: Number.isFinite(price) ? price : null,
    currency: String(txn.currency ?? 'TZS').trim() || 'TZS',
    source: 'transaction',
  }
}

function isUsablePackageName(name) {
  const n = String(name ?? '').trim()
  if (!n) return false
  return n.toLowerCase() !== 'kifurushi'
}

function mergeContext(base, resolved) {
  if (!resolved) return base
  return {
    planName: isUsablePackageName(base.planName)
      ? base.planName
      : isUsablePackageName(resolved.planName)
        ? resolved.planName
        : '',
    price:
      base.price != null && Number.isFinite(Number(base.price))
        ? Number(base.price)
        : resolved.price != null && Number.isFinite(Number(resolved.price))
          ? Number(resolved.price)
          : null,
    currency: String(base.currency ?? resolved.currency ?? 'TZS').trim() || 'TZS',
  }
}

/**
 * @param {{ deviceId?: string, transactionId?: string, planName?: string, price?: number|null, currency?: string }} input
 */
export async function resolveSubscriptionSmsPackageContext(input = {}) {
  const deviceId = String(input.deviceId ?? '').trim()
  const transactionId = String(input.transactionId ?? '').trim()
  let ctx = {
    planName: isUsablePackageName(input.planName) ? String(input.planName).trim() : '',
    price:
      input.price != null && Number.isFinite(Number(input.price)) ? Number(input.price) : null,
    currency: String(input.currency ?? 'TZS').trim() || 'TZS',
  }

  if (ctx.planName && ctx.price != null) return ctx

  const orderId = extractPaymentOrderIdFromSubscriptionTxn(transactionId)
  if (orderId) {
    ctx = mergeContext(ctx, await packageFromTransactionOrderId(orderId))
  }
  if (ctx.planName && ctx.price != null) return ctx

  if (deviceId) {
    const latest = await getLatestCompletedTransactionForDevice(deviceId)
    if (latest?.order_id) {
      ctx = mergeContext(ctx, await packageFromTransactionOrderId(latest.order_id))
    }
    if (!ctx.planName || ctx.price == null) {
      const grant = await getLatestManualSubscriptionGrantRecord(deviceId)
      if (grant?.id != null) {
        ctx = mergeContext(ctx, await packageFromTransactionOrderId(`manual_grant:${grant.id}`))
      }
    }
  }

  return ctx
}
