/**
 * Static verification for Beem SMS + device phone + transactional lifecycle SMS.
 * Run: node scripts/verify-sms-integration.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(root, 'src')

function read(rel) {
  return readFileSync(path.join(src, rel), 'utf8')
}

const checks = []
function assert(name, ok) {
  checks.push({ name, ok })
}

assert('billingTables beem_settings', read('db/billingTables.js').includes('beem_settings'))
assert('billingTables sms_templates', read('db/billingTables.js').includes('sms_templates'))
assert('billingTables sms_send_log', read('db/billingTables.js').includes('sms_send_log'))
assert('billingTables device_phone_registry', read('db/billingTables.js').includes('device_phone_registry'))
assert('billingTables sms_type column', read('db/billingTables.js').includes('sms_type'))
assert('beemSms client', read('lib/beemSms.js').includes('apisms.beem.africa'))
assert('beem sender normalize', read('lib/beemSms.js').includes('normalizeBeemSenderName'))
assert('phoneNormalize international', read('lib/phoneNormalize.js').includes('normalizePhoneInternational'))
assert('devicePhoneStore save once', read('lib/devicePhoneStore.js').includes('saveDevicePhoneOnce'))
assert('transactional messages payment_success', read('lib/smsTransactionalMessages.js').includes('buildPaymentSuccessSms'))
assert('smsService sendTransactionalSms', read('lib/smsService.js').includes('sendTransactionalSms'))
assert('smsService phone_missing log', read('lib/smsService.js').includes('phone_missing'))
assert('smsExpiryReminders 24h window', read('lib/smsExpiryReminders.js').includes("interval '24 hours'"))
assert('smsExpiryReminders expired once', read('lib/smsExpiryReminders.js').includes('expired:'))
assert('payment success idempotency', read('lib/smsSubscriptionHooks.js').includes('payment_success:'))
assert('activation hook', read('billingStore.js').includes('smsSubscriptionHooks'))
assert('device phone routes', read('routes/devicePhonePublic.js').includes('devicePhonePublicRouter'))
assert('runtime device-phone mount', read('routes/runtimePublic.js').includes("'/device-phone'"))
assert('restApi beem mount', read('routes/restApi.js').includes("restApi.use('/settings/beem'"))
assert('restApi sms admin', read('routes/restApi.js').includes("restApi.use('/admin/sms'"))
assert('sms log query filters', read('lib/smsLogQuery.js').includes('buildSmsLogListQuery'))
assert('sms log resend route', read('routes/smsAdmin.js').includes('/log/:id/resend'))
assert('scheduler import', read('routes/restApi.js').includes("import './smsScheduler.js'"))

const failed = checks.filter((c) => !c.ok)
for (const c of checks) {
  console.log(c.ok ? 'OK' : 'FAIL', c.name)
}
if (failed.length) {
  console.error(`\n${failed.length} check(s) failed`)
  process.exit(1)
}
console.log('\nAll SMS integration checks passed.')
