import { computeStackedExpiryIso } from '../src/lib/subscriptionStacking.js'

const MS_DAY = 24 * 60 * 60 * 1000
const now = Date.UTC(2026, 4, 24, 12, 0, 0)

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function daysFromNow(iso, baseMs) {
  return (new Date(iso).getTime() - baseMs) / MS_DAY
}

// 1 day remaining + 7 day package => 8 days from now
{
  const prev = new Date(now + MS_DAY).toISOString()
  const out = computeStackedExpiryIso(prev, 7, now)
  const totalDays = daysFromNow(out.expiresAt, now)
  assert(out.stacked === true, 'should stack when active')
  assert(Math.abs(totalDays - 8) < 0.01, `expected ~8 days, got ${totalDays}`)
  console.log('PASS stack 1d + 7d => 8d from now')
}

// expired subscription => 7 days from now
{
  const prev = new Date(now - MS_DAY).toISOString()
  const out = computeStackedExpiryIso(prev, 7, now)
  const totalDays = daysFromNow(out.expiresAt, now)
  assert(out.stacked === false, 'should not stack when expired')
  assert(Math.abs(totalDays - 7) < 0.01, `expected ~7 days, got ${totalDays}`)
  console.log('PASS expired + 7d => 7d from now')
}

// double renewal simulation
{
  let exp = null
  for (const days of [7, 7, 30]) {
    const out = computeStackedExpiryIso(exp, days, now)
    exp = out.expiresAt
  }
  const totalDays = daysFromNow(exp, now)
  assert(Math.abs(totalDays - 44) < 0.01, `expected ~44 days stacked, got ${totalDays}`)
  console.log('PASS triple stack 7+7+30')
}

console.log('All subscription stacking tests passed.')
