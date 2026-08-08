import { runSmsExpiryReminders } from '../lib/smsExpiryReminders.js'
import { isStartupReady } from '../lib/startupReadiness.js'

const INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.SMS_EXPIRY_REMINDER_MS) || 60 * 60 * 1000,
)

function runWhenReady(label, fn) {
  if (!isStartupReady()) return
  void fn().catch((e) => {
    console.error(`[sms-scheduler] ${label} failed:`, e)
  })
}

setInterval(() => {
  runWhenReady('scheduled run', runSmsExpiryReminders)
}, INTERVAL_MS)

console.log(`[sms-scheduler] expiry reminders every ${INTERVAL_MS}ms (waits for startup.ready)`)
