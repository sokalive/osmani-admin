/**
 * Production regression: GET /api/channels includes authorizedPackageName on every row.
 * Usage: node server/scripts/verify-channels-authorized-package-live.mjs [baseUrl]
 */
const base = (process.argv[2] || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')

const healthRes = await fetch(`${base}/api/health`)
const health = await healthRes.json()
console.log('health.commit:', health.commit)

const res = await fetch(`${base}/api/channels`)
if (!res.ok) {
  console.error('FAIL channels HTTP', res.status)
  process.exit(1)
}
const channels = await res.json()
if (!Array.isArray(channels)) {
  console.error('FAIL channels payload is not an array')
  process.exit(1)
}

console.log('channels.count:', channels.length)

const requiredKeys = ['id', 'name', 'url', 'authorizedPackageName', 'authorized_package_name']
let shapeOk = 0
let withPackage = 0
const sample = []

for (const ch of channels) {
  const ok = requiredKeys.every((k) => k in ch)
  if (!ok) {
    console.error('FAIL missing keys on channel', ch.id, ch.name)
    process.exit(1)
  }
  if (ch.authorizedPackageName !== ch.authorized_package_name) {
    console.error('FAIL camel/snake mismatch', ch.id)
    process.exit(1)
  }
  shapeOk += 1
  if (String(ch.authorizedPackageName).trim()) withPackage += 1
  if (sample.length < 3) {
    sample.push({
      id: ch.id,
      name: ch.name,
      authorizedPackageName: ch.authorizedPackageName,
      accessType: ch.accessType,
    })
  }
}

console.log('shape_ok:', shapeOk)
console.log('with_authorized_package_name:', withPackage)
console.log('sample:', JSON.stringify(sample, null, 2))
console.log('Regression passed: all channels load with backward-compatible authorizedPackageName field.')
