import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatAdminDateTime } from '../../src/lib/formatAdminDateTime.js'
import {
  getAdminSensitiveActionPassword,
  verifyAdminSensitiveActionPassword,
} from '../src/lib/adminSensitiveActionPassword.js'
import { computeMidnightEatExpiryIso } from '../src/lib/subscriptionStacking.js'

const here = dirname(fileURLToPath(import.meta.url))

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

{
  const issued = Date.parse('2026-10-16T07:29:00.000Z')
  const exp = computeMidnightEatExpiryIso(7, issued)
  assert(exp === '2026-10-22T21:00:00.000Z', `16 Oct 2026 + 7d expected 23 Oct 00:00 EAT, got ${exp}`)
  const shown = formatAdminDateTime(exp)
  assert(shown.includes('23'), `display day, got ${shown}`)
  assert(shown.includes('October'), `display month, got ${shown}`)
  assert(shown.includes('2026'), `display year, got ${shown}`)
  assert(!shown.includes('2027'), `must not show 2027, got ${shown}`)
  console.log('PASS 7-day offer issued 16 Oct 2026 displays', shown)
}

{
  const issued = Date.parse('2026-07-25T09:00:00.000Z')
  const exp = computeMidnightEatExpiryIso(7, issued)
  assert(exp === '2026-07-31T21:00:00.000Z', `25 Jul + 7d expected 1 Aug 00:00 EAT, got ${exp}`)
  const shown = formatAdminDateTime(exp)
  assert(shown.includes('1') && shown.includes('August') && shown.includes('2026'), shown)
  console.log('PASS documented rule buy 25 Jul duration 7 expires', shown)
}

{
  const issued = Date.parse('2026-10-16T20:59:00.000Z')
  const exp = computeMidnightEatExpiryIso(7, issued)
  assert(exp === '2026-10-22T21:00:00.000Z', 'late evening EAT still uses that calendar day')
  console.log('PASS expiry is calendar-day exclusive, not a 24-hour voucher')
}

{
  const billing = readFileSync(join(here, '../src/billingStore.js'), 'utf8')
  const insert = billing.slice(billing.indexOf('export async function insertOfferCodeRow'))
  const insertBody = insert.slice(0, insert.indexOf('function offerCodeRowStatus'))
  assert(insertBody.includes('computeMidnightEatExpiryIso(days)'), 'new codes must use the package calendar rule')
  assert(!insertBody.includes('OFFER_CODE_SHELF_DAYS'), 'new codes must not use the 365-day shelf')
  assert(!insertBody.includes("interval '1 day'"), 'new codes must not add shelf days in SQL')
  console.log('PASS insert stores the package expiry timestamp')
}

{
  const route = readFileSync(join(here, '../src/routes/manualSubscriptionAdmin.js'), 'utf8')
  assert(route.includes("post('/grant', rateLimitGrant"), 'grant keeps its rate limit')
  assert(route.includes("post('/grant-custom', rateLimitGrant"), 'custom grant keeps its rate limit')
  assert(route.includes('verifyAdminSensitiveActionPassword(pin)'), 'grant still verifies the sensitive-action PIN')
  const limiter = route.slice(route.indexOf('function rateLimitGrant'), route.indexOf('function rateLimitSetup'))
  assert(limiter.includes('429'), 'excess attempts still return 429')
  console.log('PASS grant PIN check and rate limit are unchanged')
}

{
  const key = 'ADMIN_SENSITIVE_ACTION_PASSWORD'
  const previous = process.env[key]
  process.env[key] = 'fixture-pin-value'
  assert(verifyAdminSensitiveActionPassword('fixture-pin-value') === true, 'configured PIN must be accepted')
  assert(verifyAdminSensitiveActionPassword('0000') === false, 'wrong PIN must be rejected')
  assert(verifyAdminSensitiveActionPassword('') === false, 'empty PIN must be rejected')
  delete process.env[key]
  const fallback = getAdminSensitiveActionPassword()
  assert(fallback.length >= 4, 'unset env must still resolve a PIN')
  assert(verifyAdminSensitiveActionPassword(fallback) === true, 'resolved PIN must be accepted')
  assert(verifyAdminSensitiveActionPassword('0000') === false, 'wrong PIN must stay rejected')
  if (previous == null) delete process.env[key]
  else process.env[key] = previous
  console.log('PASS sensitive-action PIN accepts the configured value and rejects others')
}
