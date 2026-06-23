/**
 * Render legacy APK path smoke test (v16–v23).
 * Usage: node scripts/verify-render-legacy-stability.mjs
 */
const RENDER = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(
  /\/+$/,
  '',
)
const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const WANT_COMMIT_PREFIX = String(process.env.WANT_COMMIT || '78506a0').slice(0, 7)

let failed = 0

function fail(msg) {
  console.error(`FAIL ${msg}`)
  failed += 1
}

function pass(msg) {
  console.log(`OK ${msg}`)
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { cache: 'no-store', ...opts })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

async function main() {
  const health = await fetchJson(`${RENDER}/api/health`)
  if (health.status !== 200) fail(`Render health ${health.status}`)
  else pass(`Render health 200 commit=${String(health.body?.commit || '').slice(0, 12)}`)
  if (!String(health.body?.commit || '').startsWith(WANT_COMMIT_PREFIX)) {
    fail(`Render commit want ${WANT_COMMIT_PREFIX}* got ${health.body?.commit}`)
  }

  for (const path of [
    '/api/channels',
    '/api/update-check?version_code=20',
    '/api/analytics/snapshot',
    `/api/subscription-status?device_id=render-stability-probe`,
  ]) {
    const { status } = await fetchJson(`${RENDER}${path}`)
    if (status === 200) pass(`Render GET ${path} => 200`)
    else fail(`Render GET ${path} => ${status}`)
  }

  const verify = await fetchJson(`${RENDER}/api/subscription/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: 'render-stability-probe' }),
  })
  if (verify.status === 200) {
    pass('Render POST /api/subscription/verify => 200')
    const b = verify.body || {}
    if (b.blocked === true && b.status === 'blocked') {
      fail('verify returned blocked for probe device (unexpected suspended shape)')
    } else {
      pass(`verify probe active=${b.active} blocked=${b.blocked} status=${b.status}`)
    }
  } else {
    fail(`Render POST /api/subscription/verify => ${verify.status}`)
  }

  const vpsHealth = await fetchJson(`${VPS}/api/health`)
  if (vpsHealth.status === 200) pass(`VPS health 200 commit=${String(vpsHealth.body?.commit || '').slice(0, 12)}`)
  else fail(`VPS health ${vpsHealth.status}`)

  if (failed) process.exit(1)
  console.log('\nPASS Render legacy stability')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
