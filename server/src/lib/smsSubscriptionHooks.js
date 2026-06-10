import { resolvePaymentPhoneForDevice } from '../billingStore.js'
import { sendTemplatedSms } from './smsService.js'

const LOG_PREFIX = '[sms-activation]'

/**
 * Fire-and-forget SMS after subscription activation. Never throws to caller.
 */
export async function notifySubscriptionActivated({ deviceId, orderId, expiresAt }) {
  const d = String(deviceId ?? '').trim()
  const oid = String(orderId ?? '').trim()
  if (!d) return { skipped: true, reason: 'no_device' }

  try {
    const { phone } = await resolvePaymentPhoneForDevice(d)
    if (!phone) {
      console.log(LOG_PREFIX, 'no phone for device', d.slice(0, 20))
      return { skipped: true, reason: 'no_phone' }
    }
    const expIso =
      expiresAt instanceof Date ? expiresAt.toISOString() : String(expiresAt ?? '')
    const idempotencyKey = `activated:${oid || d}:${expIso.slice(0, 10)}`

    return await sendTemplatedSms({
      phone,
      templateKey: 'subscription_activated',
      deviceId: d,
      triggerType: 'subscription_activated',
      idempotencyKey,
      context: { deviceId: d, expiresAt: expIso },
    })
  } catch (e) {
    console.warn(LOG_PREFIX, 'failed', d, e)
    return { ok: false, error: String(e?.message || e) }
  }
}
