/**
 * Verify Auto Download promotes SOFT → FORCE (non-cancelable) for v16–v23.
 * Run: node scripts/verify-app-update-auto-download.mjs
 */
import {
  APP_UPDATE_NEVER_MIN,
  applyAppUpdateClientDecision,
  enrichAppUpdateClientFields,
  resolveAppUpdateDecision,
} from '../src/lib/appUpdateTargeting.js'
import { appUpdateToOtaPayload } from '../src/routes/appUpdate.js'

const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')

const checks = []
function assert(name, ok, detail = '') {
  checks.push({ name, ok, detail })
}

const catalog = {
  decision: 'SOFT',
  soft_update: true,
  force_update: false,
  auto_download: true,
  autoDownload: true,
  softUpdate: true,
  forceUpdate: false,
  version_code: 24,
  apk_url: 'https://example.com/app.apk',
}

for (const v of [16, 17, 18, 19, 20, 21, 22, 23]) {
  const resolved = resolveAppUpdateDecision({
    soft: true,
    force: false,
    autoDownload: true,
    versionCode: 24,
    hasAnyUrl: true,
  })
  assert(`resolve v${v} base decision`, resolved === 'FORCE', resolved)

  const out = applyAppUpdateClientDecision(
    enrichAppUpdateClientFields({ ...catalog, decision: resolved }),
    v,
  )
  assert(
    `v${v} FORCE non-cancelable`,
    out.decision === 'FORCE' &&
      out.cancelable === false &&
      out.force_update === true &&
      out.soft_update === false &&
      out.auto_download === true,
    JSON.stringify({
      decision: out.decision,
      cancelable: out.cancelable,
      force_update: out.force_update,
    }),
  )
}

const v24 = applyAppUpdateClientDecision(enrichAppUpdateClientFields({ ...catalog, decision: 'FORCE' }), 24)
assert(
  `v${APP_UPDATE_NEVER_MIN} NONE when latest`,
  v24.decision === 'NONE' && v24.cancelable === false,
  JSON.stringify({ decision: v24.decision, reason: v24.update_target_reason }),
)

const softOnly = applyAppUpdateClientDecision(
  enrichAppUpdateClientFields({
    ...catalog,
    auto_download: false,
    autoDownload: false,
    decision: 'SOFT',
  }),
  20,
)
assert(
  'soft without auto stays cancelable',
  softOnly.decision === 'SOFT' && softOnly.cancelable === true && softOnly.force_update === false,
)

const forceOnly = applyAppUpdateClientDecision(
  enrichAppUpdateClientFields({
    ...catalog,
    auto_download: false,
    autoDownload: false,
    decision: 'FORCE',
    forceUpdate: true,
    softUpdate: false,
  }),
  20,
)
assert(
  'force update unchanged',
  forceOnly.decision === 'FORCE' && forceOnly.cancelable === false,
)

const ota = appUpdateToOtaPayload(
  applyAppUpdateClientDecision(
    enrichAppUpdateClientFields({ ...catalog, decision: 'FORCE' }),
    20,
  ),
  1,
)
assert(
  'OTA payload includes cancelable + force_update',
  ota.cancelable === false && ota.force_update === true && ota.auto_download === true,
)

async function liveWhenAutoOn() {
  const res = await fetch(`${VPS}/api/update-check?version_code=20`, { cache: 'no-store' })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  if (body.auto_download !== true) {
    console.log('SKIP live v20 — auto_download not enabled in production (simulation checks passed)')
    return
  }
  assert(
    'live v20 auto_download non-cancelable',
    body.decision === 'FORCE' && body.cancelable === false && body.force_update === true,
    JSON.stringify({
      decision: body.decision,
      cancelable: body.cancelable,
      force_update: body.force_update,
      auto_download: body.auto_download,
    }),
  )
  const v24live = await fetch(`${VPS}/api/update-check?version_code=24`, { cache: 'no-store' }).then((r) =>
    r.json(),
  )
  assert('live v24 NONE', v24live.decision === 'NONE', v24live.decision)
}

await liveWhenAutoOn().catch((e) => assert('live VPS probe', false, e.message))

const failed = checks.filter((c) => !c.ok)
for (const c of checks) console.log(c.ok ? 'OK' : 'FAIL', c.name, c.detail ? `— ${c.detail}` : '')
if (failed.length) {
  console.error(`\n${failed.length} check(s) failed`)
  process.exit(1)
}
console.log(`\nAll ${checks.length} auto-download update checks passed.`)
