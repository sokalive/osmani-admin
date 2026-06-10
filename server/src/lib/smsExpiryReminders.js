import { resolvePaymentPhoneForDevice } from '../billingStore.js'
import { sendTemplatedSms } from './smsService.js'
import { getPool } from '../db/pool.js'

const EAT = 'Africa/Dar_es_Salaam'
const LOG_PREFIX = '[sms-expiry]'

/**
 * Daily expiry reminders: 3 days before, 1 day before, and on expiry.
 * Idempotent via sms_send_log.idempotency_key = device:template:expiry_date.
 */
export async function runSmsExpiryReminders() {
  const pool = getPool()
  const results = { sent: 0, skipped: 0, failed: 0, errors: [] }

  const { rows: expiring3d } = await pool.query(
    `SELECT ds.device_id, ds.expires_at
     FROM device_subscriptions ds
     WHERE ds.status = 'active'
       AND ds.manual_admin_blocked IS NOT TRUE
       AND ds.expires_at > now()
       AND (ds.expires_at AT TIME ZONE $1)::date = ((now() AT TIME ZONE $1)::date + 3)`,
    [EAT],
  )

  const { rows: expiring1d } = await pool.query(
    `SELECT ds.device_id, ds.expires_at
     FROM device_subscriptions ds
     WHERE ds.status = 'active'
       AND ds.manual_admin_blocked IS NOT TRUE
       AND ds.expires_at > now()
       AND (ds.expires_at AT TIME ZONE $1)::date = ((now() AT TIME ZONE $1)::date + 1)`,
    [EAT],
  )

  const { rows: expiredToday } = await pool.query(
    `SELECT ds.device_id, ds.expires_at
     FROM device_subscriptions ds
     WHERE ds.manual_admin_blocked IS NOT TRUE
       AND ds.expires_at <= now()
       AND (ds.expires_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date`,
    [EAT],
  )

  const jobs = [
    ...expiring3d.map((r) => ({
      deviceId: r.device_id,
      expiresAt: r.expires_at,
      templateKey: 'subscription_expiring_soon',
      triggerType: 'expiry_reminder_3d',
    })),
    ...expiring1d.map((r) => ({
      deviceId: r.device_id,
      expiresAt: r.expires_at,
      templateKey: 'subscription_expiring_soon',
      triggerType: 'expiry_reminder_1d',
    })),
    ...expiredToday.map((r) => ({
      deviceId: r.device_id,
      expiresAt: r.expires_at,
      templateKey: 'subscription_expired',
      triggerType: 'expiry_today',
    })),
  ]

  for (const job of jobs) {
    const deviceId = String(job.deviceId ?? '').trim()
    if (!deviceId) continue
    const exp =
      job.expiresAt instanceof Date
        ? job.expiresAt.toISOString().slice(0, 10)
        : String(job.expiresAt ?? '').slice(0, 10)
    const idempotencyKey = `${deviceId}:${job.triggerType}:${exp}`

    try {
      const { phone } = await resolvePaymentPhoneForDevice(deviceId)
      if (!phone) {
        results.skipped += 1
        continue
      }
      const r = await sendTemplatedSms({
        phone,
        templateKey: job.templateKey,
        deviceId,
        triggerType: job.triggerType,
        idempotencyKey,
        context: {
          deviceId,
          expiresAt: job.expiresAt instanceof Date ? job.expiresAt.toISOString() : String(job.expiresAt),
        },
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
      console.warn(LOG_PREFIX, 'job failed', deviceId, e)
    }
  }

  if (results.sent > 0 || results.failed > 0) {
    console.log(LOG_PREFIX, 'run complete', results)
  }
  return results
}
