import { resolvePaymentPhoneForDevice } from '../billingStore.js'
import {
  buildExpiredSubscriptionSms,
  buildExpiryReminderSms,
  subscriptionPeriodKey,
} from './smsTransactionalMessages.js'
import { resolveSubscriptionSmsPackageContext } from './smsSubscriptionPackageContext.js'
import { resolveSmsPhoneForDevice, sendTransactionalSms } from './smsService.js'
import { getPool } from '../db/pool.js'

const EAT = 'Africa/Dar_es_Salaam'
const LOG_PREFIX = '[sms-expiry]'

async function loadSubscriptionSmsContext(row) {
  const deviceId = String(row.device_id ?? '').trim()
  const transactionId = String(row.transaction_id ?? '').trim()
  const expiresAt = row.expires_at
  const pkg = await resolveSubscriptionSmsPackageContext({
    deviceId,
    transactionId,
    planName: row.plan_name,
    price: row.amount != null ? Number(row.amount) : null,
    currency: String(row.currency ?? 'TZS').trim() || 'TZS',
  })
  return {
    deviceId,
    transactionId,
    expiresAt,
    planName: pkg.planName,
    price: pkg.price,
    currency: pkg.currency,
    subscriptionId: subscriptionPeriodKey({ deviceId, transactionId, expiresAt }),
  }
}

/**
 * Expiry reminder (~24h before) and expired SMS — once per subscription period.
 */
export async function runSmsExpiryReminders() {
  const pool = getPool()
  const results = { sent: 0, skipped: 0, failed: 0, errors: [] }

  const { rows: expiring24h } = await pool.query(
    `SELECT ds.device_id, ds.expires_at, ds.transaction_id,
            p.name AS plan_name, t.amount, t.currency
     FROM device_subscriptions ds
     LEFT JOIN transactions t ON t.order_id = ds.transaction_id
     LEFT JOIN plans p ON p.id = t.plan_id
     WHERE ds.status = 'active'
       AND ds.manual_admin_blocked IS NOT TRUE
       AND ds.expires_at > now()
       AND ds.expires_at <= now() + interval '24 hours'`,
  )

  const { rows: expiredRows } = await pool.query(
    `SELECT ds.device_id, ds.expires_at, ds.transaction_id,
            p.name AS plan_name, t.amount, t.currency
     FROM device_subscriptions ds
     LEFT JOIN transactions t ON t.order_id = ds.transaction_id
     LEFT JOIN plans p ON p.id = t.plan_id
     WHERE ds.manual_admin_blocked IS NOT TRUE
       AND ds.expires_at <= now()
       AND ds.expires_at >= now() - interval '7 days'`,
  )

  const jobs = [
    ...expiring24h.map((r) => ({ row: r, kind: 'expiry_reminder' })),
    ...expiredRows.map((r) => ({ row: r, kind: 'expired' })),
  ]

  for (const job of jobs) {
    const ctx = await loadSubscriptionSmsContext(job.row)
    if (!ctx.deviceId) continue

    const idempotencyKey =
      job.kind === 'expiry_reminder'
        ? `expiry_reminder:${ctx.subscriptionId}`
        : `expired:${ctx.subscriptionId}`

    if (job.kind === 'expired') {
      const { rows: activeNow } = await pool.query(
        `SELECT 1 FROM device_subscriptions
         WHERE device_id = $1 AND status = 'active' AND expires_at > now()
         LIMIT 1`,
        [ctx.deviceId],
      )
      if (activeNow.length) {
        results.skipped += 1
        continue
      }
    }

    try {
      const { phone: fallbackPhone } = await resolvePaymentPhoneForDevice(ctx.deviceId)
      const resolved = await resolveSmsPhoneForDevice(ctx.deviceId, fallbackPhone)
      const message =
        job.kind === 'expiry_reminder'
          ? buildExpiryReminderSms({
              planName: ctx.planName,
              price: ctx.price,
              currency: ctx.currency,
              expiresAt: ctx.expiresAt,
            })
          : buildExpiredSubscriptionSms({
              planName: ctx.planName,
              price: ctx.price,
              currency: ctx.currency,
            })

      const r = await sendTransactionalSms({
        phone: resolved.normalized || resolved.phone || fallbackPhone,
        message,
        deviceId: ctx.deviceId,
        smsType: job.kind,
        subscriptionId: ctx.subscriptionId,
        paymentId: ctx.transactionId,
        triggerType: job.kind,
        idempotencyKey,
        templateKey: job.kind,
      })

      if (r.skipped) results.skipped += 1
      else if (r.ok) results.sent += 1
      else {
        results.failed += 1
        if (r.error) results.errors.push(r.error)
      }
    } catch (e) {
      results.failed += 1
      results.errors.push(String(e?.message || e))
      console.warn(LOG_PREFIX, 'job failed', ctx.deviceId, e)
    }
  }

  if (results.sent > 0 || results.failed > 0) {
    console.log(LOG_PREFIX, 'run complete', results)
  }
  return results
}
