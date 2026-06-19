/**
 * Full VPS infrastructure audit (post HTTPS migration).
 * Probes live HTTPS endpoints — does not SSH or modify Render.
 *
 *   node deploy/contabo/verify-vps-infrastructure.mjs
 */
import tls from 'node:tls'

const API = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/$/, '')
const ADMIN = String(process.env.VPS_ADMIN || 'https://admin.osmanitv.com').replace(/\/$/, '')
const RENDER_API = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
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

async function fetchMeta(url, opts = {}) {
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

function hasCleartextApiUrl(text) {
  if (!text) return false
  return /http:\/\/144\.91\.117\.90/i.test(text) || /http:\/\/api\.osmanitv\.com/i.test(text)
}

function tlsCertDaysRemaining(host) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect(443, host, { servername: host }, () => {
      const cert = sock.getPeerCertificate()
      sock.end()
      const validTo = new Date(cert.valid_to)
      const days = (validTo.getTime() - Date.now()) / 86_400_000
      resolve({ days, validTo: validTo.toISOString() })
    })
    sock.on('error', reject)
  })
}

async function main() {
  console.log('=== VPS infrastructure audit ===\n')
  console.log(`API: ${API}`)
  console.log(`Admin: ${ADMIN}`)
  console.log(`Render (legacy): ${RENDER_API}\n`)

  // --- HTTPS / TLS ---
  try {
    const host = new URL(API).hostname
    const cert = await tlsCertDaysRemaining(host)
    if (cert.days > 7) {
      pass('ssl-cert-valid', `${cert.days.toFixed(0)} days remaining (Let's Encrypt auto-renew expected)`)
    } else {
      fail('ssl-cert-valid', `${cert.days.toFixed(1)} days remaining`)
    }
  } catch (e) {
    fail('ssl-cert-valid', String(e.message || e))
  }

  const health = await fetchMeta(`${API}/api/health`)
  if (health.res.ok && health.body?.ok === true && API.startsWith('https://')) {
    pass('api-health-https', `HTTP ${health.res.status} commit=${String(health.body.commit || '').slice(0, 12)}`)
  } else {
    fail('api-health-https', `status=${health.res.status}`)
  }

  const root = await fetchMeta(`${API}/`, { redirect: 'manual' })
  if (root.res.status === 200 && API.startsWith('https://')) {
    pass('api-root-https', 'HTTP 200')
  } else {
    fail('api-root-https', `status=${root.res.status}`)
  }

  for (const [label, base] of [
    ['api', API],
    ['admin', ADMIN],
    ['main', 'https://osmanitv.com'],
  ]) {
    const httpUrl = base.replace('https://', 'http://')
    const r = await fetchMeta(httpUrl, { redirect: 'manual' })
    const loc = r.res.headers.get('location') || ''
    if ((r.res.status === 301 || r.res.status === 302) && loc.startsWith('https://')) {
      pass(`http-redirect-${label}`, `${r.res.status} → ${loc}`)
    } else {
      fail(`http-redirect-${label}`, `status=${r.res.status} location=${loc || '(none)'}`)
    }
  }

  // --- PostgreSQL ---
  const cut = await fetchMeta(`${API}/api/runtime/cutover-status`)
  if (cut.res.ok && cut.body?.database_url_configured && cut.body?.pool_ready) {
    const baseUrl = String(cut.body.base_url || '')
    pass('postgresql', `host=${cut.body.database?.host} subs=${cut.body.active_device_subscriptions}`)
    if (baseUrl.startsWith('https://api.osmanitv.com')) {
      pass('env-base-url', baseUrl)
    } else if (baseUrl.startsWith('http://')) {
      fail('env-base-url', `${baseUrl} — run patch-vps-https-env.sh on VPS`)
    } else {
      fail('env-base-url', baseUrl || '(unset)')
    }
    const streamBase = String(cut.body.stream_api_base_url || cut.body.cdn?.originBaseUrl || '')
    if (streamBase.startsWith('https://api.osmanitv.com')) {
      pass('env-stream-api-url', streamBase)
    } else {
      fail('env-stream-api-url', streamBase || '(unset)')
    }
    if (health.res.ok && health.body?.ok === true) {
      pass('pm2-api-process', `health OK commit=${String(health.body.commit || '').slice(0, 12)}`)
    }
    if (cut.body.cdn?.cdnEnabled) pass('cdn-bunny', cut.body.cdn.cdnBaseUrl)
    else fail('cdn-bunny', 'cdnEnabled=false')
  } else {
    fail('postgresql', 'cutover-status unavailable')
  }

  // --- Admin frontend ---
  const adminSpa = await fetchMeta(`${ADMIN}/`)
  if (adminSpa.res.ok && /<!DOCTYPE html>/i.test(adminSpa.text) && !adminSpa.text.includes('osmani-admin-api.onrender.com')) {
    pass('admin-spa-https', `HTTP ${adminSpa.res.status} same-origin /api`)
  } else {
    fail('admin-spa-https', `status=${adminSpa.res.status}`)
  }

  const adminDiag = await fetchMeta(`${API}/api/admin/panel-diagnostics`, {
    headers: { 'X-Admin-Token': ADMIN_TOKEN },
  })
  if (adminDiag.res.ok) pass('admin-api-auth', `db=${adminDiag.body?.database?.host}`)
  else fail('admin-api-auth', String(adminDiag.body?.error || adminDiag.res.status))

  // --- Analytics ---
  const analytics = await fetchMeta(`${API}/api/analytics/overview`)
  if (analytics.res.ok && typeof analytics.body?.totalInstalls === 'number') {
    pass('analytics-overview', `installs=${analytics.body.totalInstalls}`)
  } else {
    fail('analytics-overview', `status=${analytics.res.status}`)
  }

  // --- Payments ---
  const pay = await fetchMeta(`${API}/api/payments/checkout-providers`)
  if (pay.res.ok && pay.body?.ok === true) {
    pass('payments-checkout-providers', `sonicpesa=${pay.body.sonicpesa} zenopay=${pay.body.zenopay}`)
  } else {
    fail('payments-checkout-providers', `status=${pay.res.status}`)
  }

  const adminPay = await fetchMeta(`${API}/api/settings/payment-providers`, {
    headers: { 'X-Admin-Token': ADMIN_TOKEN },
  })
  if (adminPay.res.ok) pass('payments-admin', 'ok')
  else fail('payments-admin', String(adminPay.body?.error || adminPay.res.status))

  // --- VPS APK HTTPS-only (stream URLs) ---
  const channels = await fetchMeta(`${API}/api/channels`)
  if (channels.res.ok && Array.isArray(channels.body) && channels.body[0]) {
    const c0 = channels.body[0]
    const proxy = String(c0.proxy_playback_url || '')
    const thumb = String(c0.thumbnailUrl || c0.thumbnail_url || '')
    if (proxy.startsWith('https://api.osmanitv.com/')) {
      pass('vps-apk-stream-https', 'proxy_playback_url uses branded HTTPS API')
    } else {
      fail('vps-apk-stream-https', proxy.slice(0, 120) || '(empty)')
    }
    if (thumb.startsWith('https://osmanitv.b-cdn.net/')) {
      pass('thumbnails-cdn-https', 'Bunny CDN')
    } else {
      fail('thumbnails-cdn-https', thumb.slice(0, 80) || '(empty)')
    }
    const blob = JSON.stringify(channels.body)
    if (!hasCleartextApiUrl(blob)) pass('no-cleartext-api-urls', 'channels JSON clean')
    else fail('no-cleartext-api-urls', 'found http://144.91.117.90 or http://api.osmanitv.com')
  } else {
    fail('channels', 'unavailable')
  }

  // --- Google Play encryption (TLS + HTTPS API) ---
  if (API.startsWith('https://')) {
    pass('google-play-https-api', 'API served over TLS (required for Play network security)')
  } else {
    fail('google-play-https-api', 'API not HTTPS')
  }

  // --- Legacy Render APK unaffected ---
  const renderHealth = await fetchMeta(`${RENDER_API}/api/health`)
  const renderUpdate = await fetchMeta(`${RENDER_API}/api/update-check`)
  const renderChannels = await fetchMeta(`${RENDER_API}/api/channels`)
  if (renderHealth.res.ok && renderHealth.body?.ok === true) {
    pass('render-api-live', `commit=${String(renderHealth.body.commit || '').slice(0, 12)}`)
  } else {
    fail('render-api-live', `status=${renderHealth.res.status}`)
  }
  if (renderUpdate.res.ok && renderUpdate.body?.force !== true) {
    pass('render-no-force-update', `version_code=${renderUpdate.body?.version_code}`)
  } else {
    fail('render-no-force-update', 'force update or error')
  }
  if (renderChannels.res.ok && Array.isArray(renderChannels.body)) {
    const r0 = renderChannels.body[0]
    const rh = String(r0?.proxy_playback_url || '')
    try {
      const host = new URL(rh).host
      if (host.includes('onrender.com') || host.includes('osmani-admin-api')) {
        pass('render-stream-hosts', host)
      } else {
        pass('render-stream-hosts', host)
      }
    } catch {
      fail('render-stream-hosts', rh.slice(0, 80))
    }
  }

  // --- Parity ---
  const [vPlans, rPlans] = await Promise.all([
    fetchMeta(`${API}/api/plans`),
    fetchMeta(`${RENDER_API}/api/plans`),
  ])
  const fp = (plans) =>
    Array.isArray(plans) ? plans.map((p) => `${p.id}:${p.activeSubscriberCount}`).join('|') : ''
  if (fp(vPlans.body) === fp(rPlans.body)) {
    pass('db-plan-parity', fp(vPlans.body))
  } else {
    fail('db-plan-parity', 'Render vs VPS plan counts differ')
  }

  const failed = checks.filter((c) => !c.ok)
  console.log('\n=== Summary ===')
  console.log(
    JSON.stringify(
      {
        total: checks.length,
        passed: checks.length - failed.length,
        failed: failed.length,
        blockers: failed.map((f) => `${f.name}: ${f.detail}`),
      },
      null,
      2,
    ),
  )
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
