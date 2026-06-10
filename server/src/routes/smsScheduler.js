import { runSmsExpiryReminders } from '../lib/smsExpiryReminders.js'

const INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.SMS_EXPIRY_REMINDER_MS) || 60 * 60 * 1000,
)

void runSmsExpiryReminders().catch((e) => {
  console.error('[sms-scheduler] initial run failed:', e)
})

setInterval(() => {
  void runSmsExpiryReminders().catch((e) => {
    console.error('[sms-scheduler] scheduled run failed:', e)
  })
}, INTERVAL_MS)

console.log(`[sms-scheduler] expiry reminders every ${INTERVAL_MS}ms`)
