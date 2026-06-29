#!/usr/bin/env node
/**
 * Live verification: device phone API + transactional SMS idempotency helpers.
 *
 * Usage:
 *   node scripts/verify-device-phone-transactional-sms.mjs
 *   VPS_API=https://api.osmanitv.com node scripts/verify-device-phone-transactional-sms.mjs
 */
import {
  buildExpiredPackageLine,
  buildExpiredSubscriptionSms,
  buildExpiryReminderSms,
  buildPaymentSuccessSms,
  formatExpirySwahili,
  formatSwahiliClockTime,
  formatTzPrice,
  subscriptionPeriodKey,
} from '../src/lib/smsTransactionalMessages.js'
import { normalizePhoneInternational } from '../src/lib/phoneNormalize.js'

const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/$/, '')
const deviceId = `verify-phone-${Date.now()}`
const installId = 'install-verify-1'

const report = { time: new Date().toISOString(), pass: true, checks: [] }

function ok(name, detail = '') {
  report.checks.push({ name, ok: true, detail })
  console.log('PASS', name, detail)
}

function fail(name, detail = '') {
  report.pass = false
  report.checks.push({ name, ok: false, detail })
  console.error('FAIL', name, detail)
}

async function jsonFetch(url, opts = {}) {
  const res = await fetch(url, opts)
  const body = await res.json().catch(() => null)
  return { res, body }
}

function testMessageBuilders() {
  const expiresAt = new Date('2026-07-04T11:35:00.000Z')
  const success = buildPaymentSuccessSms({
    planName: 'Wiki',
    price: 3000,
    currency: 'TZS',
    expiresAt,
  })
  if (!success.includes('Hongera! Malipo yako yamefanikiwa.')) {
    fail('payment_success wording')
  } else if (!success.includes('Kifurushi: Wiki')) {
    fail('payment_success plan name')
  } else if (!success.includes('Bei: TZS 3,000')) {
    fail('payment_success price format')
  } else {
    ok('payment_success message builder')
  }

  const reminder = buildExpiryReminderSms({
    planName: 'Wiki 1',
    price: 3000,
    currency: 'TZS',
    expiresAt,
  })
  if (!reminder.includes('Kumbusho!') || !reminder.includes('kinaisha kesho Saa')) {
    fail('expiry_reminder wording')
  } else if (!reminder.includes('Vipindi Vyote Live kupitia simu yako')) {
    fail('expiry_reminder CTA')
  } else {
    ok('expiry_reminder message builder')
  }

  const expired = buildExpiredSubscriptionSms({ planName: 'Wiki 1', price: 3000, currency: 'TZS' })
  if (!expired.includes('Kifurushi chako cha Wiki 1 (TZS 3,000) kimeisha.')) {
    fail('expired with package and price', expired.split('\n')[2])
  } else {
    ok('expired message with package + price')
  }

  const expiredNoPrice = buildExpiredSubscriptionSms({ planName: 'Wiki 1' })
  if (!expiredNoPrice.includes('Kifurushi chako cha Wiki 1 kimeisha.')) {
    fail('expired package only')
  } else {
    ok('expired message package only')
  }

  const expiredUnknown = buildExpiredSubscriptionSms({})
  if (!expiredUnknown.includes('Kifurushi chako kimeisha.')) {
    fail('expired unknown package')
  } else if (expiredUnknown.includes('cha Kifurushi')) {
    fail('expired must not contain cha Kifurushi')
  } else {
    ok('expired message unknown package fallback')
  }

  const badDefault = buildExpiredPackageLine({ planName: '' })
  if (badDefault.includes('cha Kifurushi')) {
    fail('buildExpiredPackageLine generic guard')
  } else {
    ok('buildExpiredPackageLine no double Kifurushi')
  }

  const key = subscriptionPeriodKey({
    deviceId: 'dev1',
    transactionId: 'ord1',
    expiresAt,
  })
  if (!key.includes('dev1') || !key.includes('ord1')) fail('subscriptionPeriodKey')
  else ok('subscriptionPeriodKey', key)

  ok('formatTzPrice', formatTzPrice(3000))
  ok('formatSwahiliClockTime', formatSwahiliClockTime(expiresAt))
  ok('formatExpirySwahili', formatExpirySwahili(expiresAt))
}

function testNormalization() {
  const tz = normalizePhoneInternational('0712345678')
  const us = normalizePhoneInternational('+1 (415) 555-2671', { defaultCountry: 'US' })
  const ke = normalizePhoneInternational('+254 712 345 678')
  if (!tz.valid || tz.normalized !== '255712345678') fail('TZ normalize', JSON.stringify(tz))
  else ok('TZ phone normalize', tz.normalized)
  if (!us.valid || us.normalized.length < 10) fail('US normalize', JSON.stringify(us))
  else ok('US phone normalize', us.normalized)
  if (!ke.valid || !ke.normalized.startsWith('254')) fail('KE normalize', JSON.stringify(ke))
  else ok('KE phone normalize', ke.normalized)
}

async function testDevicePhoneApi() {
  const base = `${VPS}/api/runtime/device-phone`

  const statusEmpty = await jsonFetch(`${base}/status?device_id=${encodeURIComponent(deviceId)}`)
  if (!statusEmpty.res.ok || statusEmpty.body?.hasPhone !== false) {
    fail('GET status empty', JSON.stringify(statusEmpty.body))
  } else ok('GET status empty')

  const saveTz = await jsonFetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_id: deviceId,
      install_instance_id: installId,
      phone: '0712 345 678',
    }),
  })
  if (!saveTz.res.ok || saveTz.body?.saved !== true || !saveTz.body?.hasPhone) {
    fail('POST save TZ', JSON.stringify(saveTz.body))
  } else ok('POST save TZ phone', saveTz.body.phoneNumberNormalized)

  const saveDup = await jsonFetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_id: deviceId,
      install_instance_id: installId,
      phone: '0788 111 222',
    }),
  })
  if (!saveDup.res.ok || saveDup.body?.saved !== false || saveDup.body?.reason !== 'already_exists') {
    fail('POST save once guard', JSON.stringify(saveDup.body))
  } else ok('POST save once guard')

  const deviceId2 = `${deviceId}-us`
  const saveUs = await jsonFetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_id: deviceId2,
      install_instance_id: installId,
      phone: '+1-415-555-2671',
    }),
  })
  if (!saveUs.res.ok || saveUs.body?.saved !== true) {
    fail('POST save US', JSON.stringify(saveUs.body))
  } else ok('POST save US phone', saveUs.body.phoneNumberNormalized)

  const update = await jsonFetch(base, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_id: deviceId,
      install_instance_id: installId,
      phone: '+255 712 345 678',
    }),
  })
  if (!update.res.ok || update.body?.saved !== true) {
    fail('PUT update phone', JSON.stringify(update.body))
  } else ok('PUT update phone')
}

testMessageBuilders()
testNormalization()
await testDevicePhoneApi()

console.log('\nReport:', JSON.stringify(report, null, 2))
process.exit(report.pass ? 0 : 1)
