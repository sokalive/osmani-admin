/**
 * Verify Contabo cutover — thumbnails, admin API, subscriptions DB, no Render dependency.
 *
 * Usage:
 *   node deploy/contabo/verify-cutover.mjs
 *   API_BASE=http://144.91.117.90 node deploy/contabo/verify-cutover.mjs
 */
const API_BASE = String(process.env.API_BASE || 'https://api.osmanitv.com').replace(/\/$/, '')
const API_PORT = String(process.env.API_PORT || '10001').trim()
const RENDER_URL = 'https://osmani-admin-api.onrender.com'
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '3030'

const checks = []

function pass(name, detail) {
  checks.push({ name, ok: true, detail })
  console.log(`✓ ${name}: ${detail}`)
}

function fail(name, detail) {
  checks.push({ name, ok: false, detail })
  console.error(`✗ ${name}: ${detail}`)
}

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

async function headOk(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' })
    const ct = res.headers.get('content-type') || ''
    return { ok: res.ok, status: res.status, contentType: ct }
  } catch (e) {
    return { ok: false, status: 0, contentType: String(e.message || e) }
  }
}

async function main() {
  console.log('=== Contabo cutover verification ===')
  console.log('API_BASE:', API_BASE)
  console.log('API_PORT:', API_PORT)

  // Health on nginx + direct port
  for (const [label, url] of [
    ['health:nginx', `${API_BASE}/api/health`],
    ['health:direct', `http://127.0.0.1:${API_PORT}/api/health`],
  ]) {
    try {
      const { res, body } = await fetchJson(url)
      if (res.ok && body?.ok) pass(label, `commit=${body.commit || 'unknown'}`)
      else fail(label, `status ${res.status}`)
    } catch (e) {
      if (label.includes('direct') && API_BASE.includes('144.91')) {
        console.log(`  (skip ${label} — not on VPS)`)
      } else {
        fail(label, String(e.message || e))
      }
    }
  }

  // Cutover status
  const cutover = await fetchJson(`${API_BASE}/api/runtime/cutover-status`)
  if (cutover.res.ok && cutover.body?.ok) {
    const b = cutover.body
    pass('cutover-status', JSON.stringify({
      db: b.database,
      dbUrlConfigured: b.database_url_configured,
      plans: b.plan_count,
      active_subs: b.active_device_subscriptions,
      cdn: b.cdn?.cdnEnabled,
      cdnBase: b.cdn?.cdnBaseUrl,
      adminToken: b.admin_token_configured,
      envFiles: b.env_files_loaded,
      uploads: b.uploads_file_count,
    }))
    if (!b.database_url_configured) fail('database-url', 'DATABASE_URL not in process env')
    if (!b.cdn?.cdnEnabled) fail('bunny-cdn', 'BUNNY_CDN_BASE_URL not set — thumbnails will break')
    if (!b.admin_token_configured) fail('admin-token', 'ADMIN_API_TOKEN not set — admin UI auth fails')
    if (!b.database?.configured) fail('database', 'DATABASE_URL not configured')
  } else {
    fail('cutover-status', `status ${cutover.res.status} (deploy latest code for this endpoint)`)
  }

  // Catalog endpoints
  for (const path of ['/api/channels', '/api/banners', '/api/plans']) {
    const { res, body } = await fetchJson(`${API_BASE}${path}`)
    const count = Array.isArray(body) ? body.length : null
    if (res.ok && count != null) pass(path, `${count} rows`)
    else fail(path, `status ${res.status}`)
  }

  // Compare plans with Render (same DB → identical subscriber counts)
  try {
    const [local, render] = await Promise.all([
      fetchJson(`${API_BASE}/api/plans`),
      fetchJson(`${RENDER_URL}/api/plans`),
    ])
    if (local.res.ok && render.res.ok) {
      const l = local.body.map((p) => `${p.id}:${p.activeSubscriberCount}`).join(',')
      const r = render.body.map((p) => `${p.id}:${p.activeSubscriberCount}`).join(',')
      if (l === r) pass('plans-vs-render', 'subscriber counts match (same DB)')
      else fail('plans-vs-render', `local=[${l}] render=[${r}]`)
    }
  } catch (e) {
    console.log('  (skip plans-vs-render — Render unreachable)')
  }

  // Thumbnails
  const ch = await fetchJson(`${API_BASE}/api/channels`)
  if (ch.res.ok && Array.isArray(ch.body) && ch.body[0]?.thumbnailUrl) {
    const thumb = ch.body[0].thumbnailUrl
    pass('channel-thumbnail-url', thumb)
    const h = await headOk(thumb)
    if (h.ok && /image\//i.test(h.contentType)) {
      pass('channel-thumbnail-fetch', `${h.status} ${h.contentType}`)
    } else {
      fail('channel-thumbnail-fetch', `${h.status} ${h.contentType} for ${thumb}`)
    }
    if (thumb.includes('onrender.com') && !thumb.includes('b-cdn.net')) {
      fail('thumbnail-host', 'still pointing at Render origin')
    }
    if (thumb.startsWith(`http://${API_BASE.replace(/^https?:\/\//, '')}`) && !thumb.includes('b-cdn.net')) {
      fail('thumbnail-host', 'Contabo origin without CDN — nginx /uploads may serve SPA HTML')
    }
  }

  // /uploads via nginx
  const uploadProbe = await headOk(`${API_BASE}/uploads/1779094722261-31e89ecad3ddf8c1.webp`)
  if (uploadProbe.ok && /image\//i.test(uploadProbe.contentType)) {
    pass('nginx-uploads-proxy', `${uploadProbe.status} ${uploadProbe.contentType}`)
  } else if (uploadProbe.contentType.includes('text/html')) {
    fail('nginx-uploads-proxy', 'returns HTML (SPA fallback) — fix nginx /uploads proxy')
  }

  // Subscription endpoint shape
  const sub = await fetchJson(`${API_BASE}/api/subscription-status?device_id=cutover-probe`)
  if (sub.res.ok && sub.body && 'active' in sub.body && Array.isArray(sub.body.plans)) {
    pass('subscription-status', `active=${sub.body.active} plans=${sub.body.plans.length}`)
  } else {
    fail('subscription-status', `status ${sub.res.status}`)
  }

  // Admin auth
  const admin = await fetchJson(`${API_BASE}/api/admin/panel-diagnostics`, {
    headers: { 'X-Admin-Token': ADMIN_TOKEN },
  })
  if (admin.res.ok && admin.body?.ok) {
    pass('admin-diagnostics', `db=${admin.body.database?.host || 'ok'}`)
  } else {
    fail('admin-diagnostics', admin.body?.error || `status ${admin.res.status}`)
  }

  const failed = checks.filter((c) => !c.ok)
  console.log('\n=== Summary ===')
  console.log(JSON.stringify({ total: checks.length, failed: failed.length, failedNames: failed.map((f) => f.name) }, null, 2))
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
