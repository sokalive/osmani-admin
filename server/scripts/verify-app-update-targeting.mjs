/**
 * Verify v15-only update popup targeting on VPS + Render.
 *
 *   node scripts/verify-app-update-targeting.mjs
 */
import {
  APP_UPDATE_NEVER_MIN,
  APP_UPDATE_POPUP_TARGET_VERSION,
  APP_UPDATE_VPS_MIGRATION_MAX,
  APP_UPDATE_VPS_MIGRATION_MIN,
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
  { v: APP_UPDATE_POPUP_TARGET_VERSION, want: 'SOFT', reason: 'v15_play_store_cohort' },
  { v: APP_UPDATE_VPS_MIGRATION_MIN, want: 'NONE', reason: 'vps_ota_migration_cohort' },
  { v: APP_UPDATE_VPS_MIGRATION_MAX, want: 'NONE', reason: 'vps_ota_migration_cohort' },
  { v: APP_UPDATE_NEVER_MIN, want: 'NONE', reason: 'version_24_plus' },
  { v: 14, want: 'NONE', reason: 'not_target_version' },
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
  try {
    const h = await fetch(`${host.base}/api/health`).then((r) => r.json())
    if (h?.commit) pass(`${host.label} commit ${String(h.commit).slice(0, 7)}`)
  } catch (e) {
    fail(`${host.label} health: ${e.message}`)
    continue
  }

  for (const v of [15, 16, 20, 23, 24]) {
    try {
      const body = await fetchUpdateCheck(host.base, v)
      const want = v === 15 ? 'SOFT' : 'NONE'
      if (body.decision !== want) {
        fail(`${host.label} v${v}: decision=${body.decision}, want ${want}`)
      } else {
        pass(`${host.label} v${v} => ${body.decision}`)
      }
    } catch (e) {
      fail(`${host.label} v${v}: ${e.message}`)
    }
  }
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll app-update targeting checks passed.')
