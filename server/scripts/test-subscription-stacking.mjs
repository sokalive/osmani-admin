import {
  computeStackedExpiryIso,
  computeMidnightEatExpiryIso,
  computeRemainingCalendarDaysEat,
  eatDateParts,
  eatMidnightUtcIso,
} from '../src/lib/subscriptionStacking.js'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

// Purchase 25 Jul 2026 08:00 UTC (= 11:00 EAT) duration 7 → expire 1 Aug 00:00 EAT
{
  const now = Date.UTC(2026, 6, 25, 8, 0, 0)
  const out = computeStackedExpiryIso(null, 7, now)
  const expected = eatMidnightUtcIso(2026, 8, 1)
  assert(out.stacked === false, 'new purchase must not stack')
  assert(out.expiry_policy === 'midnight_africa_dar_es_salaam', 'midnight policy')
  assert(out.expiresAt === expected, `expected ${expected}, got ${out.expiresAt}`)
  assert(computeRemainingCalendarDaysEat(out.expiresAt, now) === 7, 'remaining calendar days should be 7')
  console.log('PASS Jul25 08:00 + 7d => Aug1 00:00 EAT')
}

// Purchase 25 Jul 2026 22:30 EAT (= 19:30 UTC) duration 7 → still Aug1 00:00 EAT
{
  const now = Date.UTC(2026, 6, 25, 19, 30, 0)
  const out = computeStackedExpiryIso(null, 7, now)
  const expected = eatMidnightUtcIso(2026, 8, 1)
  assert(out.expiresAt === expected, `expected ${expected}, got ${out.expiresAt}`)
  console.log('PASS Jul25 22:30 EAT + 7d => Aug1 00:00 EAT')
}

// Active previous expiry is preserved (never shortened, stacking disabled)
{
  const now = Date.UTC(2026, 6, 25, 12, 0, 0)
  const prev = new Date(now + 10 * 86400000).toISOString()
  const out = computeStackedExpiryIso(prev, 7, now)
  assert(out.stacked === false, 'stacking disabled')
  assert(out.expiry_policy === 'preserve_existing_active', 'preserve active')
  assert(out.expiresAt === prev, 'must not change existing active expiry')
  console.log('PASS preserve existing active expiry (no stack)')
}

// Expired previous → midnight policy from now
{
  const now = Date.UTC(2026, 6, 25, 12, 0, 0)
  const prev = new Date(now - 86400000).toISOString()
  const out = computeStackedExpiryIso(prev, 3, now)
  const expected = computeMidnightEatExpiryIso(3, now)
  assert(out.expiresAt === expected, `expected ${expected}, got ${out.expiresAt}`)
  console.log('PASS expired + 3d => midnight EAT')
}

// Helper sanity: EAT date parts
{
  const p = eatDateParts(Date.UTC(2026, 6, 25, 21, 0, 0)) // 25 Jul 21:00 UTC = 26 Jul 00:00 EAT
  assert(p.year === 2026 && p.month === 7 && p.day === 26, `EAT date parts ${JSON.stringify(p)}`)
  console.log('PASS EAT date parts across midnight')
}

console.log('All subscription expiry policy tests passed.')
