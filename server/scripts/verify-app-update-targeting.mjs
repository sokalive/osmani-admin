/**
 * Verify update-check: v15–v23 => SOFT/FORCE, v24+ => NONE.
 */
import {
  APP_UPDATE_NEVER_MIN,
  applyAppUpdateClientDecision,
} from '../src/lib/appUpdateTargeting.js'

const VPS_API = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const RENDER_API = String(
  process.env.RENDER_API || 'https://osmani-admin-api.onrender.com',
).replace(/\/+$/, '')

const HOSTS = [
  { label: 'VPS', base: VPS_API },
  { label: 'Render', base: RENDER_API },
]

async function fetchUpdateCheck(base, versionCode) {
  const res = await fetch(`${base}/api/update-check?version_code=${versionCode}`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${base} v${versionCode}: HTTP ${res.status}`)
  return body
}

let failed = 0
function fail(msg) {
  console.error('FAIL', msg)
  failed += 1
}
function pass(msg) {
  console.log('OK', msg)
}

const baseSoft = { decision: 'SOFT', version_code: 24 }

for (const c of [
  { v: 15, want: 'SOFT' },
  { v: 20, want: 'SOFT' },
  { v: 23, want: 'SOFT' },
  { v: APP_UPDATE_NEVER_MIN, want: 'NONE' },
  { v: 14, want: 'SOFT' },
]) {
  const got = applyAppUpdateClientDecision(baseSoft, c.v)
  if (got.decision !== c.want) {
    fail(`simulated v${c.v}: decision=${got.decision}, want ${c.want}`)
  } else {
    pass(`simulated v${c.v} => ${got.decision} (${got.update_target_reason})`)
  }
}

console.log('\n=== Live hosts ===')
for (const host of HOSTS) {
  const health = await fetch(`${host.base}/api/health`, { cache: 'no-store' })
    .then((r) => r.json())
    .catch(() => ({}))
  if (health?.commit) pass(`${host.label} commit ${String(health.commit).slice(0, 7)}`)

  for (let v = 15; v <= 24; v++) {
    const data = await fetchUpdateCheck(host.base, v).catch((e) => {
      fail(`${host.label} v${v}: ${e.message}`)
      return null
    })
    if (!data) continue
    const want = v >= 24 ? 'NONE' : 'SOFT'
    if (!['SOFT', 'FORCE'].includes(String(data.decision)) && want !== 'NONE') {
      if (data.decision !== want) fail(`${host.label} v${v}: decision=${data.decision}, want ${want}`)
    } else if (data.decision !== want) {
      fail(`${host.label} v${v}: decision=${data.decision}, want ${want}`)
    } else {
      pass(`${host.label} v${v} => ${data.decision}`)
    }
  }
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll app update targeting checks passed.')
