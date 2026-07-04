import {
  getPlanRowByIdAny,
  getTransactionByOrderId,
  phoneFromTransactionRow,
  resolvePaymentPhoneForDevice,
} from '../billingStore.js'
import {
  buildPaymentSuccessSms,
  subscriptionPeriodKey,
} from './smsTransactionalMessages.js'
import { resolveSmsPhoneForDevice, sendTransactionalSms } from './smsService.js'

const LOG_PREFIX = '[sms-payment-success]'

function isManualGrantOrder(orderId) {
  return String(orderId ?? '').trim().startsWith('manual_grant:')
}

/**
 * Fire-and-forget payment-success SMS after admin manual grant. Never throws to caller.
 */
export async function notifyManualGrantActivated({
  deviceId,
  grantId,
  planId,
  planName,
  price,
  expiresAt,
  phone,
}) {
  const d = String(deviceId ?? '').trim()
  const gid = Number(grantId)
  const oid = Number.isSafeInteger(gid) && gid > 0 ? `manual_grant:${gid}` : ''
  if (!d || !oid) return { skipped: true, reason: 'no_device_or_grant' }

  try {
    let resolvedPlanName = String(planName ?? '').trim()
    let resolvedPrice = price != null && Number.isFinite(Number(price)) ? Number(price) : null
    if ((!resolvedPlanName || resolvedPrice == null) && planId != null) {
      const plan = await getPlanRowByIdAny(planId)
      if (plan) {
        if (!resolvedPlanName) resolvedPlanName = String(plan.name ?? '')
        if (resolvedPrice == null && plan.price != null) resolvedPrice = Number(plan.price)
      }
    }

    const { phone: fallbackPhone } = await resolvePaymentPhoneForDevice(d)
    const phoneHint = String(phone ?? '').trim() || fallbackPhone
    const resolved = await resolveSmsPhoneForDevice(d, phoneHint)
    const message = buildPaymentSuccessSms({
      planName: resolvedPlanName,
      price: resolvedPrice,
      currency: 'TZS',
      expiresAt,
    })

    const idempotencyKey = `payment_success:${oid}`
    const subscriptionId = subscriptionPeriodKey({
      deviceId: d,
      transactionId: oid,
      expiresAt,
    })

    return await sendTransactionalSms({
      phone: resolved.normalized || resolved.phone || phoneHint,
      message,
      deviceId: d,
      smsType: 'payment_success',
      subscriptionId,
      paymentId: oid,
      triggerType: 'payment_success',
      idempotencyKey,
      templateKey: 'payment_success',
    })
  } catch (e) {
    console.warn(LOG_PREFIX, 'manual grant failed', d, e)
    return { ok: false, error: String(e?.message || e) }
  }
}

/**
 * Fire-and-forget SMS after paid subscription activation. Never throws to caller.
 */
export async function notifySubscriptionActivated({ deviceId, orderId, expiresAt }) {
  const d = String(deviceId ?? '').trim()
  const oid = String(orderId ?? '').trim()
  if (!d) return { skipped: true, reason: 'no_device' }
  if (!oid || isManualGrantOrder(oid)) {
    return { skipped: true, reason: 'not_payment_activation' }
  }

  try {
    const txn = await getTransactionByOrderId(oid)
    if (!txn || String(txn.status ?? '').trim() !== 'completed') {
      return { skipped: true, reason: 'not_completed_payment' }
    }

    const plan = txn.plan_id ? await getPlanRowByIdAny(txn.plan_id) : null
    const txnPhone = phoneFromTransactionRow(txn)
    const { phone: fallbackPhone } = await resolvePaymentPhoneForDevice(d)
    const resolved = await resolveSmsPhoneForDevice(d, txnPhone || fallbackPhone)
    const message = buildPaymentSuccessSms({
      planName: plan?.name ?? txn.plan_name,
      price: txn.amount ?? plan?.price,
      currency: txn.currency || 'TZS',
      expiresAt,
    })

    const idempotencyKey = `payment_success:${oid}`
    const subscriptionId = subscriptionPeriodKey({
      deviceId: d,
      transactionId: oid,
      expiresAt,
    })

    return await sendTransactionalSms({
      phone: resolved.normalized || resolved.phone || fallbackPhone,
      message,
      deviceId: d,
      smsType: 'payment_success',
      subscriptionId,
      paymentId: oid,
      triggerType: 'payment_success',
      idempotencyKey,
      templateKey: 'payment_success',
    })
  } catch (e) {
    console.warn(LOG_PREFIX, 'failed', d, e)
    return { ok: false, error: String(e?.message || e) }
  }
}

/**
 * SMS after admin payment recovery (MANUALLY_APPROVED — not provider-completed txn).
 */
export async function notifyAdminPaymentRecoveryActivated({
  deviceId,
  orderId,
  expiresAt,
  planId,
  amount,
}) {
  const d = String(deviceId ?? '').trim()
  const oid = String(orderId ?? '').trim()
  if (!d || !oid) return { skipped: true, reason: 'no_device_or_order' }

  try {
    const plan = planId ? await getPlanRowByIdAny(planId) : null
    const { phone: fallbackPhone } = await resolvePaymentPhoneForDevice(d)
    const resolved = await resolveSmsPhoneForDevice(d, fallbackPhone)
    const message = buildPaymentSuccessSms({
      planName: plan?.name ?? '',
      price: amount ?? plan?.price,
      currency: 'TZS',
      expiresAt,
    })

    const idempotencyKey = `admin_recovery_sms:${oid}`
    const subscriptionId = subscriptionPeriodKey({
      deviceId: d,
      transactionId: oid,
      expiresAt,
    })

    return await sendTransactionalSms({
      phone: resolved.normalized || resolved.phone || fallbackPhone,
      message,
      deviceId: d,
      smsType: 'payment_success',
      subscriptionId,
      paymentId: oid,
      triggerType: 'admin_payment_recovery',
      idempotencyKey,
      templateKey: 'payment_success',
    })
  } catch (e) {
    console.warn('[sms-admin-recovery]', 'failed', d, e)
    return { ok: false, error: String(e?.message || e) }
  }
}
