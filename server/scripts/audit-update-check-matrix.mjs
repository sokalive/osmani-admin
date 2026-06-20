/**
 * Audit /api/update-check matrix v16–v24 on VPS + Render.
 * Usage: node scripts/audit-update-check-matrix.mjs
 */
const HOSTS = [
  { label: 'VPS', base: 'https://api.osmanitv.com' },
  { label: 'Render', base: 'https://osmani-admin-api.onrender.com' },
]

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { cache: 'no-store', ...opts })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { _raw: text.slice(0, 200) }
  }
  return { status: res.status, body }
}

async function auditHost({ label, base }) {
  const row = { label, base, matrix: {}, errors: [] }
  const health = await fetchJson(`${base}/api/health`)
  row.health = health.status
  if (health.body?.ok !== true) row.errors.push('health not ok')

  const baseCheck = await fetchJson(`${base}/api/update-check`)
  row.baseCheck = {
    status: baseCheck.status,
    version_code: baseCheck.body?.version_code,
    version_name: baseCheck.body?.version_name,
    decision: baseCheck.body?.decision,
    source: baseCheck.body?.source,
    playstore_url: baseCheck.body?.playstore_url,
  }

  const admin = await fetchJson(`${base}/api/runtime/app-update`)
  row.runtime = {
    version_code: admin.body?.version_code,
    version_name: admin.body?.version_name,
    decision: admin.body?.decision,
    source: admin.body?.source,
  }

  for (let v = 16; v <= 24; v++) {
    const r = await fetchJson(`${base}/api/update-check?version_code=${v}`)
    row.matrix[`v${v}`] = r.body?.decision ?? `HTTP_${r.status}`
  }

  // POST body style (some legacy APK clients)
  const post23 = await fetchJson(`${base}/api/update-check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ version_code: 23, versionCode: 23 }),
  })
  row.postV23 = post23.body?.decision

  return row
}

console.log('Host audit', new Date().toISOString())
const results = []
for (const h of HOSTS) {
  const r = await auditHost(h)
  results.push(r)
  console.log(JSON.stringify(r, null, 2))
  console.log('---')
}

// Table
const header = ['Host', ...Array.from({ length: 9 }, (_, i) => `v${16 + i}`)]
console.log('\n' + header.join('\t'))
for (const r of results) {
  const cells = [r.label]
  for (let v = 16; v <= 24; v++) cells.push(r.matrix[`v${v}`] ?? '?')
  console.log(cells.join('\t'))
}
