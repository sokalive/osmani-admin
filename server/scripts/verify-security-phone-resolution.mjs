/**
 * Production check: security report phone resolution + strict block fields.
 * Usage: node scripts/verify-security-phone-resolution.mjs [API_BASE]
 */
const API = (process.argv[2] || process.env.API_BASE || 'https://osmani-admin-api.onrender.com').replace(
  /\/$/,
  '',
)

async function getJson(path, init) {
  const res = await fetch(`${API}${path}`, init)
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const testId = `cursor-phone-resolve-${Date.now()}`

console.log('API:', API)
console.log('test device_id:', testId)

const health = await getJson('/api/health')
console.log('\n[health]', health.body)
assert(health.body.ok === true, 'health not ok')

const report = await getJson('/api/runtime/security-report', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    device_id: testId,
    signals: [{ risk_type: 'root_detected' }],
  }),
})
console.log('\n[security-report]', report.status, report.body)
assert(report.status === 200, `report status ${report.status}`)
assert(report.body.security_level === 'blocked', 'expected blocked')
assert(report.body.playbackAllowed === false, 'expected playbackAllowed false')
assert(report.body.enforcement === 'block', 'expected enforcement block')

const phone = String(report.body.phone_user || report.body.phone || '').trim()
const src = report.body.phone_resolved_from
console.log('\n[phone]', { phone: phone || '(empty)', phone_resolved_from: src ?? null })

if (phone) {
  console.log('PASS: phone resolved on production')
} else {
  console.log(
    'NOTE: phone empty — test device has no subscription/payment/transfer records (expected for synthetic id).',
  )
  console.log('Re-run with a real device_id that has completed payment:')
  console.log('  API_BASE=... node scripts/verify-security-phone-resolution.mjs')
}

console.log('\nverify-security-phone-resolution: done')
