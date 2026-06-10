/**
 * Static verification for Beem SMS integration.
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
assert('beemSms client', read('lib/beemSms.js').includes('apisms.beem.africa'))
assert('smsService sendSmsToPhone', read('lib/smsService.js').includes('sendSmsToPhone'))
assert('smsExpiryReminders', read('lib/smsExpiryReminders.js').includes('expiry_reminder_3d'))
assert('activation hook', read('billingStore.js').includes('smsSubscriptionHooks'))
assert('restApi beem mount', read('routes/restApi.js').includes("restApi.use('/settings/beem'"))
assert('restApi sms admin', read('routes/restApi.js').includes("restApi.use('/admin/sms'"))
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
