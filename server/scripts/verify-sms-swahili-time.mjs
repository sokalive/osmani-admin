#!/usr/bin/env node
/**
 * Verify Swahili clock formatting for transactional SMS.
 *
 * Usage: node scripts/verify-sms-swahili-time.mjs
 */
import {
  buildExpiryReminderSms,
  buildPaymentSuccessSms,
  formatExpirySwahili,
  formatSwahiliClockTime,
} from '../src/lib/smsTransactionalMessages.js'

let failed = 0

function fail(msg) {
  console.error(`FAIL ${msg}`)
  failed += 1
}

function ok(msg) {
  console.log(`OK ${msg}`)
}

/** Build a Date whose EAT wall-clock is hour:minute on 2026-06-28. */
function eatAt(hour, minute) {
  return new Date(Date.UTC(2026, 5, 28, hour - 3, minute, 0))
}

const CLOCK_CASES = [
  [0, 23, 'Saa 6:23 Usiku'],
  [1, 15, 'Saa 7:15 Usiku'],
  [5, 45, 'Saa 11:45 Alfajiri'],
  [6, 0, 'Saa 12:00 Asubuhi'],
  [8, 30, 'Saa 2:30 Asubuhi'],
  [11, 45, 'Saa 5:45 Asubuhi'],
  [12, 15, 'Saa 6:15 Mchana'],
  [13, 20, 'Saa 7:20 Mchana'],
  [15, 10, 'Saa 9:10 Alasiri'],
  [17, 45, 'Saa 11:45 Jioni'],
  [18, 30, 'Saa 12:30 Jioni'],
  [19, 15, 'Saa 1:15 Usiku'],
  [21, 40, 'Saa 3:40 Usiku'],
  [23, 55, 'Saa 5:55 Usiku'],
]

for (const [h, m, expected] of CLOCK_CASES) {
  const got = formatSwahiliClockTime(eatAt(h, m))
  if (got !== expected) fail(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} → "${got}" want "${expected}"`)
  else ok(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} → ${got}`)
  if (/\b\d{2}:\d{2}\b/.test(got) && got.match(/\b(0\d|1[0-9]|2[0-3]):/) && !got.includes('Saa')) {
    fail(`raw 24h leaked in ${got}`)
  }
}

const PACKAGES = [
  { planName: 'Wiki 1', price: 3000 },
  { planName: 'Mwezi 1', price: 10000 },
  { planName: 'Miezi 2', price: 18000 },
  { planName: 'Mwaka', price: 50000 },
]

for (const pkg of PACKAGES) {
  const expiresAt = eatAt(0, 23)
  const sms = buildExpiryReminderSms({ ...pkg, currency: 'TZS', expiresAt })
  if (!sms.includes(`Kifurushi chako cha ${pkg.planName} (TZS ${pkg.price.toLocaleString('en-US')})`)) {
    fail(`reminder package line for ${pkg.planName}`)
  } else {
    ok(`reminder ${pkg.planName} package + price`)
  }
  if (!sms.includes('Saa 6:23 Usiku')) fail(`reminder time for ${pkg.planName}`)
  if (!sms.includes('Vipindi Vyote Live kupitia simu yako')) fail(`reminder CTA for ${pkg.planName}`)
}

const reminder = buildExpiryReminderSms({
  planName: 'Wiki 1',
  price: 3000,
  currency: 'TZS',
  expiresAt: eatAt(0, 23),
})
if (reminder.includes('00:23') || reminder.includes('saa 00:')) {
  fail('reminder must not contain raw 24h time')
} else {
  ok('reminder avoids raw 24h')
}

const payment = buildPaymentSuccessSms({
  planName: 'Wiki 1',
  price: 3000,
  currency: 'TZS',
  expiresAt: eatAt(13, 20),
})
if (!payment.includes('Saa 7:20 Mchana')) fail('payment_success uses Swahili clock')
else ok('payment_success Swahili expiry time')

const fullExpiry = formatExpirySwahili(eatAt(15, 10))
if (!fullExpiry.includes('Saa 9:10 Alasiri')) fail('formatExpirySwahili full date')
else ok(`formatExpirySwahili → ${fullExpiry}`)

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll Swahili SMS time checks passed.')
