/**
 * Verifies production /api/plans matches manual-grant dropdown expectations.
 * Usage: node scripts/verify-manual-grant-plans.mjs [baseUrl]
 */
const base = (process.argv[2] || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')

function formatTsh(amount) {
  const n = Number(amount)
  if (!Number.isFinite(n)) return 'TSh 0'
  return `TSh ${Math.round(n).toLocaleString('en-TZ')}`
}

function label(plan) {
  const name = String(plan.name ?? '').trim() || 'Kifurushi'
  const days = Math.max(1, Math.floor(Number(plan.durationDays) || 0))
  return `${name} — ${days} siku — ${formatTsh(plan.price)}`
}

const res = await fetch(`${base}/api/plans`)
if (!res.ok) {
  console.error('FAIL plans HTTP', res.status)
  process.exit(1)
}
const plans = await res.json()
const active = plans.filter((p) => p.isActive !== false && p.expiryType !== 'fixed')
const durations = [...new Set(active.map((p) => p.durationDays))].sort((a, b) => a - b)

console.log('OK plans', active.length)
for (const p of active) {
  console.log(' -', label(p))
}
console.log('duration_days for manual grant:', durations.join(', '))
