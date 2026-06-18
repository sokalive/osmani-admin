/**
 * End-to-end legacy APK contract verification (Render + optional VPS).
 *
 * Usage:
 *   node scripts/verify-apk-backward-compatibility.mjs
 *   RENDER_API=https://osmani-admin-api.onrender.com node scripts/verify-apk-backward-compatibility.mjs
 */
const RENDER_API = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const VPS_API = String(process.env.VPS_API || 'http://144.91.117.90').replace(/\/$/, '')
const PROBE_DEVICE = 'apk-compat-probe-device'
const VERIFY_VPS = String(process.env.VERIFY_VPS ?? '1').trim() !== '0'

const LEGACY_PUBLIC_GETS = [
  { name: 'health', path: '/api/health', expect: (b) => b?.ok === true },
  {
    name: 'server-health',
    path: '/api/server-health',
    expect: (b) =>
      b?.ok === true &&
      typeof b.total_channels === 'number' &&
      typeof b.onlineChannels === 'number' &&
      (b.total_channels === 0 || b.online_channels >= 1),
  },
  {
    name: 'settings',
    path: '/api/settings',
    expect: (b) =>
      b?.ok === true &&
      typeof b.freeMode === 'boolean' &&
      b?.app_modes &&
      typeof b.app_modes.free_mode === 'boolean',
  },
  { name: 'runtime-app-modes', path: '/api/runtime/app-modes', expect: (b) => b?.ok === true && 'free_mode' in b },
  { name: 'settings-public', path: '/api/settings/public', expect: (b) => b?.whatsapp && b?.popup },
  { name: 'whatsapp-settings', path: '/api/whatsapp-settings', expect: (b) => 'enabled' in b && 'url' in b },
  { name: 'settings-whatsapp', path: '/api/settings/whatsapp', expect: (b) => 'link' in b && 'enabled' in b },
  {
    name: 'popup-settings',
    path: '/api/popup-settings',
    expect: (b) => b?.title && Array.isArray(b?.bullets ?? b?.bullet_points),
  },
  { name: 'settings-popup', path: '/api/settings/popup', expect: (b) => b?.title && (b?.bullets || b?.bullet_points) },
  { name: 'channels', path: '/api/channels', expect: (b) => Array.isArray(b) && b.length > 0 },
  { name: 'banners', path: '/api/banners', expect: (b) => Array.isArray(b) },
  { name: 'plans', path: '/api/plans', expect: (b) => Array.isArray(b) && b.length > 0 },
  {
    name: 'subscription-status',
    path: `/api/subscription-status?device_id=${encodeURIComponent(PROBE_DEVICE)}`,
    expect: (b) => typeof b?.active === 'boolean' && ('isActive' in b || 'expires_at' in b),
  },
  {
    name: 'users-intelligence-access',
    path: `/api/users-intelligence/access-check?device_id=${encodeURIComponent(PROBE_DEVICE)}`,
    expect: (b) => b?.ok === true,
  },
  {
    name: 'update-check',
    path: '/api/update-check',
    expect: (b) => b?.force !== true && Number(b?.version_code) >= 0 && b?.source === 'play',
  },
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

function verifyRenderStreamHosts(channels, renderOrigin) {
  if (!Array.isArray(channels) || channels.length === 0) {
    return { ok: false, detail: 'no channels' }
  }
  const renderHost = new URL(renderOrigin).host
  const sample = channels[0]
  const urls = [sample.proxy_playback_url, sample.direct_stream_url].filter(Boolean)
  if (urls.length === 0) {
    return { ok: true, detail: 'no stream URLs in sample (upstream-only channels)' }
  }
  const bad = urls.filter((u) => {
    try {
      const h = new URL(u).host
      return h !== renderHost && !h.includes('onrender.com')
    } catch {
      return true
    }
  })
  if (bad.length) {
    return { ok: false, detail: `stream URLs point off Render: ${bad[0].slice(0, 80)}` }
  }
  return { ok: true, detail: `stream hosts match Render (${renderHost})` }
}

async function verifyHost(label, base, { requireRenderStreams = false } = {}) {
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

  if (requireRenderStreams) {
    try {
      const { res, body } = await fetchJson(`${base}/api/channels`)
      const streamCheck = res.ok ? verifyRenderStreamHosts(body, base) : { ok: false, detail: `HTTP ${res.status}` }
      if (!streamCheck.ok) failed += 1
      results.push({ name: 'render-stream-hosts', ok: streamCheck.ok, detail: streamCheck.detail })
      console.log(`${streamCheck.ok ? '✓' : '✗'} render-stream-hosts: ${streamCheck.detail}`)
    } catch (e) {
      failed += 1
      results.push({ name: 'render-stream-hosts', ok: false, detail: String(e.message || e) })
      console.log(`✗ render-stream-hosts: ${e.message || e}`)
    }
  }

  try {
    const { res } = await fetchJson(`${base}/api/payments/create-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const ok = res.status === 400 || res.status === 422
    if (!ok) failed += 1
    results.push({
      name: 'payments-create-public',
      ok,
      detail: ok ? 'reachable without admin auth (validation error expected)' : `HTTP ${res.status}`,
    })
    console.log(`${ok ? '✓' : '✗'} payments-create-public: ${results.at(-1).detail}`)
  } catch (e) {
    failed += 1
    console.log(`✗ payments-create-public: ${e.message || e}`)
  }

  return { label, base, results, failed }
}

async function main() {
  const render = await verifyHost('OLD APK (Render)', RENDER_API, { requireRenderStreams: true })
  const hosts = [render]
  if (VERIFY_VPS) hosts.push(await verifyHost('NEW APK (VPS)', VPS_API))

  const blockers = []
  for (const host of hosts) {
    for (const r of host.results) {
      if (!r.ok) blockers.push(`${host.label}: ${r.name} — ${r.detail}`)
    }
  }

  console.log('\n=== Summary ===')
  console.log(`Render failed: ${render.failed}`)
  if (VERIFY_VPS) console.log(`VPS failed: ${hosts[1].failed}`)

  if (blockers.length) {
    console.log('\nBlockers:')
    for (const b of blockers) console.log(`  - ${b}`)
    process.exit(1)
  }

  console.log('\nAll legacy APK contracts OK.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
