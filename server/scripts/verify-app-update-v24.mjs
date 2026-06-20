/**
 * Verify App Update Control: Play Store v24 / 1.8.2, gating logic, update source.
 *
 * Usage:
 *   node scripts/verify-app-update-v24.mjs
 *   API_BASE_URL=https://api.osmanitv.com node scripts/verify-app-update-v24.mjs
 */
const base = (process.argv[2] || process.env.API_BASE_URL || 'https://api.osmanitv.com').replace(
  /\/+$/,
  '',
)

const expected = {
  version_code: 24,
  version_name: '1.8.2',
  package_name: 'com.burudanitv.app',
  source: 'play',
}

function parseVersionCode(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.trunc(n)
}

function applyClientVersionDecision(data, clientVersionInput) {
  const client = parseVersionCode(clientVersionInput)
  const server = parseVersionCode(data.version_code ?? data.versionCode)
  let decision = String(data.decision ?? 'NONE').toUpperCase()
  if (client > 0 && server > 0 && client >= server) {
    decision = 'NONE'
  }
  return decision
}

async function fetchJson(path, opts = {}) {
  const res = await fetch(`${base}${path}`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    ...opts,
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${path} ${res.status}: ${JSON.stringify(body)}`)
  return body
}

let failed = 0

function fail(msg) {
  console.error(`FAIL ${msg}`)
  failed += 1
}

function pass(msg) {
  console.log(`OK ${msg}`)
}

for (const path of ['/api/update-check', '/api/runtime/app-update']) {
  const data = await fetchJson(path)
  for (const [key, want] of Object.entries(expected)) {
    const got = data[key]
    if (got !== want) {
      fail(`${path} ${key}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
    }
  }
  if (data.decision !== 'NONE') {
    fail(`${path} decision must be NONE while update toggles are off (got ${data.decision})`)
  }
  if (!String(data.playstore_url || '').includes('play.google.com')) {
    fail(`${path} playstore_url missing or invalid`)
  }
  pass(`${path} version=${data.version_name} (${data.version_code}) decision=${data.decision}`)
}

const basePayload = await fetchJson('/api/update-check')
const gatingCases = [
  { client: 23, soft: true, force: false, want: 'SOFT', label: 'v23 + soft enabled' },
  { client: 23, soft: false, force: true, want: 'FORCE', label: 'v23 + force enabled' },
  { client: 24, soft: true, force: false, want: 'NONE', label: 'v24 + soft enabled (suppressed)' },
  { client: 25, soft: true, force: false, want: 'NONE', label: 'v25 + soft enabled (suppressed)' },
  { client: 23, soft: false, force: false, want: 'NONE', label: 'v23 + toggles off' },
]

for (const c of gatingCases) {
  let decision = 'NONE'
  if (c.force) decision = 'FORCE'
  else if (c.soft) decision = 'SOFT'
  const simulated = applyClientVersionDecision(
    { ...basePayload, decision, version_code: expected.version_code },
    c.client,
  )
  if (simulated !== c.want) {
    fail(`gating ${c.label}: got ${simulated}, want ${c.want}`)
  } else {
    pass(`gating ${c.label} => ${simulated}`)
  }
}

for (const clientCode of [23, 24]) {
  const live = await fetchJson(`/api/update-check?version_code=${clientCode}`)
  if (live.decision !== 'NONE') {
    fail(`live update-check?version_code=${clientCode} decision=${live.decision} (expected NONE while disabled)`)
  } else {
    pass(`live client ${clientCode} decision=${live.decision} (update disabled)`)
  }
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`)
  process.exit(1)
}
console.log('\nAll App Update v24 checks passed.')
