/**
 * Verify public app-update runtime matches Play Store production v17.
 * Usage: node scripts/verify-app-update-playstore-v17.mjs [apiBaseUrl]
 */
const base = (process.argv[2] || process.env.API_BASE_URL || 'https://osmani-admin-api.onrender.com')
  .replace(/\/+$/, '')

const expected = {
  version_code: 17,
  version_name: '1.7.0',
  package_name: 'com.burudanitv.app',
  source: 'play',
}

async function fetchJson(path) {
  const res = await fetch(`${base}${path}`, { headers: { Accept: 'application/json' } })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${path} ${res.status}: ${JSON.stringify(body)}`)
  return body
}

let failed = 0
for (const path of ['/api/update-check', '/api/runtime/app-update']) {
  const data = await fetchJson(path)
  for (const [key, want] of Object.entries(expected)) {
    const got = data[key]
    if (got !== want) {
      console.error(`FAIL ${path} ${key}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
      failed += 1
    }
  }
  console.log(`OK ${path}`, {
    version_code: data.version_code,
    version_name: data.version_name,
    package_name: data.package_name,
    source: data.source,
  })
}

if (failed > 0) process.exit(1)
console.log('All app-update Play Store v17 checks passed.')
