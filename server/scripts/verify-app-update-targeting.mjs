/**
 * Verify update-check: v15–v23 => SOFT/FORCE when enabled; v24+ => NONE.
 */
import {
  APP_UPDATE_NEVER_MIN,
  applyAppUpdateClientDecision,
} from '../src/lib/appUpdateTargeting.js'
import { validateApkUploadVersionCode } from '../src/lib/appUpdateUploadValidation.js'

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
  { v: 16, want: 'SOFT' },
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

for (const c of [
  {
    label: 'reupload v24 stable package',
    meta: { versionCode: 24, packageName: 'com.burudanitv.app' },
    stored: 24,
    wantOk: true,
    wantReupload: true,
  },
  {
    label: 'downgrade v23',
    meta: { versionCode: 23, packageName: 'com.burudanitv.app' },
    stored: 24,
    wantOk: false,
  },
  {
    label: 'reupload v24 wrong package',
    meta: { versionCode: 24, packageName: 'com.other.app' },
    stored: 24,
    wantOk: false,
  },
  {
    label: 'upgrade v25',
    meta: { versionCode: 25, packageName: 'com.burudanitv.app' },
    stored: 24,
    wantOk: true,
    wantReupload: false,
  },
]) {
  const got = validateApkUploadVersionCode(c.meta, c.stored)
  if (got.ok !== c.wantOk) {
    fail(`${c.label}: ok=${got.ok}, want ${c.wantOk}`)
  } else if (got.ok && Boolean(got.reupload) !== Boolean(c.wantReupload)) {
    fail(`${c.label}: reupload=${got.reupload}, want ${c.wantReupload}`)
  } else {
    pass(`${c.label} => ${got.ok ? (got.reupload ? 'reupload' : 'upgrade') : 'rejected'}`)
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
    const wantNone = v >= APP_UPDATE_NEVER_MIN
    if (wantNone && data.decision !== 'NONE') {
      fail(`${host.label} v${v}: decision=${data.decision}, want NONE`)
    } else if (!wantNone && data.decision === 'NONE' && data.update_target_reason === 'vps_ota_migration_cohort') {
      fail(`${host.label} v${v}: still blocked by vps_ota_migration_cohort`)
    } else if (!wantNone && !['NONE', 'SOFT', 'FORCE'].includes(String(data.decision))) {
      fail(`${host.label} v${v}: invalid decision=${data.decision}`)
    } else {
      pass(`${host.label} v${v} => ${data.decision}${data.update_target_reason ? ` (${data.update_target_reason})` : ''}`)
    }
  }
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll app update targeting checks passed.')
