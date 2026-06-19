/**
 * Verify osmanitv.com branded HTTPS endpoints (VPS testing — Render stays production for legacy APK).
 *
 *   node deploy/contabo/verify-osmanitv-domains.mjs
 */
const RENDER_API = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')

const HOSTS = {
  api: 'https://api.osmanitv.com',
  admin: 'https://admin.osmanitv.com',
  main: 'https://osmanitv.com',
}

const checks = []

function pass(name, detail) {
  checks.push({ name, ok: true, detail })
  console.log(`✓ ${name}: ${detail}`)
}

function fail(name, detail) {
  checks.push({ name, ok: false, detail })
  console.error(`✗ ${name}: ${detail}`)
}

async function fetchMeta(url, opts = {}) {
  const res = await fetch(url, { redirect: 'follow', cache: 'no-store', ...opts })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { res, body, text }
}

async function assertHttpsRedirect(httpUrl) {
  try {
    const res = await fetch(httpUrl, { redirect: 'manual', cache: 'no-store' })
    const loc = res.headers.get('location') || ''
    if ((res.status === 301 || res.status === 302) && loc.startsWith('https://')) {
      pass(`redirect:${httpUrl}`, `${res.status} → ${loc}`)
    } else {
      fail(`redirect:${httpUrl}`, `status=${res.status} location=${loc || '(none)'}`)
    }
  } catch (e) {
    fail(`redirect:${httpUrl}`, String(e.message || e))
  }
}

async function main() {
  console.log('=== osmanitv.com domain verification ===\n')

  for (const base of Object.values(HOSTS)) {
    await assertHttpsRedirect(base.replace('https://', 'http://'))
  }

  const health = await fetchMeta(`${HOSTS.api}/api/health`)
  if (health.res.ok && health.body?.ok === true) {
    pass('api-health', `commit=${String(health.body.commit || '').slice(0, 12)}`)
  } else {
    fail('api-health', `status ${health.res.status}`)
  }

  const admin = await fetchMeta(`${HOSTS.admin}/`)
  if (admin.res.ok && /<!DOCTYPE html>/i.test(admin.text)) {
    pass('admin-spa', `status ${admin.res.status}`)
  } else {
    fail('admin-spa', `status ${admin.res.status}`)
  }

  const main = await fetchMeta(`${HOSTS.main}/`)
  if (main.res.ok && /Osmani TV/i.test(main.text)) {
    pass('main-site', `status ${main.res.status}`)
  } else {
    fail('main-site', `status ${main.res.status}`)
  }

  const render = await fetchMeta(`${RENDER_API}/api/health`)
  if (render.res.ok && render.body?.ok === true) {
    pass('render-unchanged', `commit=${String(render.body.commit || '').slice(0, 12)}`)
  } else {
    fail('render-unchanged', `status ${render.res.status}`)
  }

  const failed = checks.filter((c) => !c.ok)
  console.log('\n=== Summary ===')
  console.log(JSON.stringify({ total: checks.length, failed: failed.length }, null, 2))
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
