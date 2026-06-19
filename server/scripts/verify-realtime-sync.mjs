/**
 * Verify cross-instance realtime sync (SSE + Postgres NOTIFY relay).
 *
 *   node scripts/verify-realtime-sync.mjs
 *   RENDER_API=https://osmani-admin-api.onrender.com VPS_API=http://144.91.117.90 node scripts/verify-realtime-sync.mjs
 */
const RENDER_API = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const VPS_API = String(process.env.VPS_API || 'http://144.91.117.90').replace(/\/$/, '')

async function probeSse(base, label) {
  const url = `${base}/api/sync/stream?topics=config,analytics`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  const events = []
  try {
    const res = await fetch(url, {
      headers: { Accept: 'text/event-stream' },
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!res.ok) return { label, base, ok: false, detail: `HTTP ${res.status}`, events }
    const reader = res.body?.getReader()
    if (!reader) return { label, base, ok: false, detail: 'no body', events }
    const decoder = new TextDecoder()
    let buffer = ''
    while (events.length < 8) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const chunks = buffer.split('\n\n')
      buffer = chunks.pop() || ''
      for (const chunk of chunks) {
        const evMatch = chunk.match(/^event: (.+)$/m)
        if (evMatch) events.push(evMatch[1].trim())
      }
      if (buffer.includes('event: app_modes') && events.length >= 2) break
    }
    await reader.cancel().catch(() => {})
    const ok = events.includes('snapshot') && (events.includes('app_modes') || events.includes('app_settings_changed'))
    return { label, base, ok, detail: ok ? 'SSE init events OK' : 'missing snapshot/app_modes', events: [...new Set(events)] }
  } catch (e) {
    return { label, base, ok: false, detail: String(e.message || e), events }
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

async function probeUpdateCheck(base, versionCode) {
  const res = await fetch(`${base}/api/update-check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version_code: versionCode, versionCode }),
    cache: 'no-store',
  })
  const body = await res.json().catch(() => null)
  const safe =
    res.ok &&
    body &&
    body.decision === 'NONE' &&
    body.force !== true &&
    (body.soft !== true || body.decision === 'NONE')
  return { base, versionCode, ok: safe, body }
}

async function main() {
  console.log('=== REALTIME SYNC VERIFICATION ===\n')
  const renderSse = await probeSse(RENDER_API, 'Render')
  const vpsSse = await probeSse(VPS_API, 'VPS')
  console.log('SSE Render:', JSON.stringify(renderSse, null, 2))
  console.log('SSE VPS:', JSON.stringify(vpsSse, null, 2))

  const uc20Render = await probeUpdateCheck(RENDER_API, 20)
  const uc21Render = await probeUpdateCheck(RENDER_API, 21)
  const uc20Vps = await probeUpdateCheck(VPS_API, 20)
  const uc21Vps = await probeUpdateCheck(VPS_API, 21)
  console.log('\nupdate-check v20 Render:', JSON.stringify(uc20Render, null, 2))
  console.log('\nupdate-check v21 Render:', JSON.stringify(uc21Render, null, 2))
  console.log('\nupdate-check v20 VPS:', JSON.stringify(uc20Vps, null, 2))
  console.log('\nupdate-check v21 VPS:', JSON.stringify(uc21Vps, null, 2))

  const healthRender = await fetch(`${RENDER_API}/api/health`).then((r) => r.json())
  const healthVps = await fetch(`${VPS_API}/api/health`).then((r) => r.json())
  console.log('\nRender commit:', healthRender.commit)
  console.log('VPS commit:', healthVps.commit)

  const ok =
    renderSse.ok &&
    vpsSse.ok &&
    uc20Render.ok &&
    uc21Render.ok &&
    uc20Vps.ok &&
    uc21Vps.ok
  console.log(`\nRESULT: ${ok ? 'PASS' : 'FAIL'}`)
  process.exit(ok ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
