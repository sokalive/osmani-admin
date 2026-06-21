/**
 * Verify App Update Control on VPS + Render: v15–v23 popup when enabled; v24+ never.
 *
 * Usage:
 *   node scripts/verify-app-update-v24.mjs
 *   VPS_API=https://api.osmanitv.com RENDER_API=https://osmani-admin-api.onrender.com node scripts/verify-app-update-v24.mjs
 */
import { applyAppUpdateClientDecision } from '../src/lib/appUpdateTargeting.js'

const VPS_API = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const RENDER_API = String(
  process.env.RENDER_API || 'https://osmani-admin-api.onrender.com',
).replace(/\/+$/, '')

const HOSTS = [
  { label: 'VPS', base: VPS_API },
  { label: 'Render', base: RENDER_API },
]

const expectedCatalog = {
  version_code: 24,
  version_name: '1.8.2',
  package_name: 'com.burudanitv.app',
  source: 'play',
}

function expectedDecisionForClient(v) {
  if (v >= 24) return 'NONE'
  return 'SOFT'
}

async function fetchJson(base, path, opts = {}) {
  const res = await fetch(`${base}${path}`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    ...opts,
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${base}${path} ${res.status}: ${JSON.stringify(body)}`)
  return body
}

async function probeSseAppUpdate(base) {
  const url = `${base}/api/sync/stream?topics=config`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 25_000)
  const events = []
  try {
    const res = await fetch(url, {
      headers: { Accept: 'text/event-stream' },
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}`, events }
    const reader = res.body?.getReader()
    if (!reader) return { ok: false, detail: 'no body', events }
    const decoder = new TextDecoder()
    let buffer = ''
    while (events.length < 12) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const chunks = buffer.split('\n\n')
      buffer = chunks.pop() || ''
      for (const chunk of chunks) {
        const evMatch = chunk.match(/^event: (.+)$/m)
        if (evMatch) events.push(evMatch[1].trim())
      }
      if (events.includes('app_update_settings')) break
    }
    await reader.cancel().catch(() => {})
    const ok = events.includes('app_update_settings') || events.includes('config.app_update_changed')
    return { ok, detail: ok ? 'SSE app_update event present' : 'missing app_update SSE', events: [...new Set(events)] }
  } catch (e) {
    const ok = events.includes('app_update_settings')
    return { ok, detail: ok ? 'SSE app_update before abort' : String(e.message || e), events: [...new Set(events)] }
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

let failed = 0

function fail(msg) {
  console.error(`FAIL ${msg}`)
  failed += 1
}

function pass(msg) {
  console.log(`OK ${msg}`)
}

const matrixByHost = {}

for (const host of HOSTS) {
  console.log(`\n=== ${host.label} (${host.base}) ===`)
  matrixByHost[host.label] = {}

  const health = await fetchJson(host.base, '/api/health').catch((e) => {
    fail(`${host.label} health: ${e.message}`)
    return null
  })
  if (health?.commit) pass(`${host.label} commit ${String(health.commit).slice(0, 7)}`)

  for (const path of ['/api/update-check', '/api/runtime/app-update']) {
    const data = await fetchJson(host.base, path).catch((e) => {
      fail(`${host.label} ${path}: ${e.message}`)
      return null
    })
    if (!data) continue
    for (const [key, want] of Object.entries(expectedCatalog)) {
      if (data[key] !== want) {
        fail(`${host.label} ${path} ${key}: got ${JSON.stringify(data[key])}, want ${JSON.stringify(want)}`)
      }
    }
    const unversionedDecision = String(data.decision || '').toUpperCase()
    if (unversionedDecision !== 'NONE') {
      fail(`${host.label} ${path} unversioned decision=${unversionedDecision}, want NONE`)
    } else {
      pass(`${host.label} ${path} unversioned => NONE (catalog v${data.version_name})`)
    }
  }

  for (let v = 15; v <= 24; v++) {
    const live = await fetchJson(host.base, `/api/update-check?version_code=${v}`).catch((e) => {
      matrixByHost[host.label][`v${v}`] = 'ERR'
      fail(`${host.label} v${v}: ${e.message}`)
      return null
    })
    if (!live) continue
    const want = expectedDecisionForClient(v)
    matrixByHost[host.label][`v${v}`] = live.decision
    if (live.decision !== want) {
      fail(`${host.label} v${v}: got ${live.decision}, want ${want}`)
    } else {
      pass(`${host.label} v${v} => ${want}`)
    }
  }

  const post15 = await fetchJson(host.base, '/api/update-check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version_code: 15, versionCode: 15 }),
  }).catch((e) => {
    fail(`${host.label} POST v15: ${e.message}`)
    return null
  })
  if (post15 && post15.decision !== 'SOFT') {
    fail(`${host.label} POST v15 decision=${post15.decision}, want SOFT`)
  } else if (post15) {
    pass(`${host.label} POST v15 => SOFT`)
  }

  const post23 = await fetchJson(host.base, '/api/update-check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version_code: 23, versionCode: 23 }),
  }).catch((e) => {
    fail(`${host.label} POST v23: ${e.message}`)
    return null
  })
  if (post23 && post23.decision !== 'SOFT') {
    fail(`${host.label} POST v23 decision=${post23.decision}, want SOFT`)
  } else if (post23) {
    pass(`${host.label} POST v23 => SOFT`)
  }

  const sse = await probeSseAppUpdate(host.base)
  if (sse.ok) pass(`${host.label} SSE: ${sse.detail}`)
  else fail(`${host.label} SSE: ${sse.detail}`)
}

console.log('\n=== Matrix (decision by client version) ===')
console.log(['Host', ...Array.from({ length: 10 }, (_, i) => `v${15 + i}`)].join('\t'))
for (const host of HOSTS) {
  const cells = [host.label]
  for (let v = 15; v <= 24; v++) cells.push(matrixByHost[host.label][`v${v}`] ?? '?')
  console.log(cells.join('\t'))
}

const basePayload = { decision: 'SOFT' }
for (const c of [
  { client: 15, want: 'SOFT', reason: 'play_store_below_v24' },
  { client: 20, want: 'SOFT', reason: 'play_store_below_v24' },
  { client: 23, want: 'SOFT', reason: 'play_store_below_v24' },
  { client: 24, want: 'NONE', reason: 'version_24_plus' },
]) {
  const got = applyAppUpdateClientDecision(basePayload, c.client)
  if (got.decision !== c.want) fail(`simulated v${c.client}: got ${got.decision}, want ${c.want}`)
  else pass(`simulated v${c.client} => ${got.decision} (${got.update_target_reason})`)
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`)
  process.exit(1)
}
console.log('\nAll dual-host App Update v15–v24 checks passed.')
