/**
 * Verify legacy (Render) + new (VPS) APK API contracts without admin auth.
 *
 * Usage:
 *   node scripts/verify-apk-backward-compatibility.mjs
 *   RENDER_API=https://osmani-admin-api.onrender.com VPS_API=http://144.91.117.90 node scripts/verify-apk-backward-compatibility.mjs
 */
const RENDER_API = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const VPS_API = String(process.env.VPS_API || 'http://144.91.117.90').replace(/\/$/, '')
const PROBE_DEVICE = 'apk-compat-probe-device'

const LEGACY_PUBLIC_GETS = [
  { name: 'health', path: '/api/health', expect: (b) => b?.ok === true },
  { name: 'server-health', path: '/api/server-health', expect: (b) => typeof b?.total_channels === 'number' },
  { name: 'settings', path: '/api/settings', expect: (b) => typeof b?.freeMode === 'boolean' },
  { name: 'runtime-app-modes', path: '/api/runtime/app-modes', expect: (b) => b?.ok === true && 'free_mode' in b },
  { name: 'settings-public', path: '/api/settings/public', expect: (b) => b?.whatsapp && b?.popup },
  { name: 'whatsapp-settings', path: '/api/whatsapp-settings', expect: (b) => 'enabled' in b && 'url' in b },
  { name: 'settings-whatsapp', path: '/api/settings/whatsapp', expect: (b) => 'link' in b && 'enabled' in b },
  { name: 'popup-settings', path: '/api/popup-settings', expect: (b) => b?.title && Array.isArray(b?.bullets ?? b?.bullet_points) },
  { name: 'settings-popup', path: '/api/settings/popup', expect: (b) => b?.title && (b?.bullets || b?.bullet_points) },
  { name: 'channels', path: '/api/channels', expect: (b) => Array.isArray(b) && b.length > 0 },
  { name: 'banners', path: '/api/banners', expect: (b) => Array.isArray(b) },
  { name: 'plans', path: '/api/plans', expect: (b) => Array.isArray(b) && b.length > 0 },
  {
    name: 'subscription-status',
    path: `/api/subscription-status?device_id=${encodeURIComponent(PROBE_DEVICE)}`,
    expect: (b) => typeof b?.active === 'boolean' || typeof b?.subscription_active === 'boolean' || 'device_id' in b,
  },
  {
    name: 'users-intelligence-access',
    path: `/api/users-intelligence/access-check?device_id=${encodeURIComponent(PROBE_DEVICE)}`,
    expect: (b) => b?.ok === true,
  },
  { name: 'update-check', path: '/api/update-check', expect: (b) => b?.force !== true && Number(b?.version_code) >= 0 },
  { name: 'runtime-app-update', path: '/api/runtime/app-update', expect: (b) => b?.force !== true },
  { name: 'checkout-providers', path: '/api/payments/checkout-providers', expect: (b) => b?.ok === true && 'payment_provider' in b },
]

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { cache: 'no-store', ...opts })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { res, body, text }
}

async function probeSseConfig(base) {
  const url = `${base}/api/sync/stream?topics=config`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const res = await fetch(url, {
      headers: { Accept: 'text/event-stream' },
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` }
    const reader = res.body?.getReader()
    if (!reader) return { ok: false, detail: 'no body' }
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      if (buffer.includes('event: app_modes') || buffer.includes('event: config')) {
        await reader.cancel().catch(() => {})
        return { ok: true, detail: 'SSE config events received' }
      }
      if (buffer.length > 12000) break
    }
    return { ok: false, detail: 'no app_modes event in first chunk' }
  } catch (e) {
    return { ok: false, detail: String(e.message || e) }
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

async function verifyHost(label, base) {
  const results = []
  let failed = 0

  console.log(`\n=== ${label} (${base}) ===`)

  for (const spec of LEGACY_PUBLIC_GETS) {
    try {
      const { res, body } = await fetchJson(`${base}${spec.path}`)
      const authBlocked = res.status === 401 || res.status === 403
      const shapeOk = res.ok && spec.expect(body)
      const ok = !authBlocked && shapeOk
      if (!ok) failed += 1
      const detail = authBlocked
        ? `BLOCKED HTTP ${res.status} (legacy APK would fail)`
        : !res.ok
          ? `HTTP ${res.status}`
          : !shapeOk
            ? 'unexpected response shape'
            : 'ok'
      results.push({ name: spec.name, ok, status: res.status, detail })
      console.log(`${ok ? '✓' : '✗'} ${spec.name}: ${detail}`)
    } catch (e) {
      failed += 1
      results.push({ name: spec.name, ok: false, status: 0, detail: String(e.message || e) })
      console.log(`✗ ${spec.name}: ${e.message || e}`)
    }
  }

  const sse = await probeSseConfig(base)
  if (!sse.ok) failed += 1
  results.push({ name: 'sync-stream-config', ok: sse.ok, detail: sse.detail })
  console.log(`${sse.ok ? '✓' : '✗'} sync-stream-config: ${sse.detail}`)

  return { label, base, results, failed }
}

async function main() {
  const render = await verifyHost('OLD APK (Render)', RENDER_API)
  const vps = await verifyHost('NEW APK (VPS)', VPS_API)

  const blockers = []
  for (const host of [render, vps]) {
    for (const r of host.results) {
      if (!r.ok) blockers.push(`${host.label}: ${r.name} — ${r.detail}`)
    }
  }

  console.log('\n=== Summary ===')
  console.log(`Render failed: ${render.failed}`)
  console.log(`VPS failed: ${vps.failed}`)

  if (blockers.length) {
    console.log('\nBlockers:')
    for (const b of blockers) console.log(`  - ${b}`)
    process.exit(1)
  }

  console.log('\nAll legacy APK public endpoints OK on both hosts.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
