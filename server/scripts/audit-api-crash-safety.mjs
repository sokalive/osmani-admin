/**
 * Live API contract audit — valid JSON + backward-compatible fields (VPS + Render).
 */
const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const RENDER = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/+$/, '')
const PROBE = `crash_audit_${Date.now()}`

const VERSIONS = [15, 19, 24]

let failed = 0
function fail(msg) {
  console.error('FAIL', msg)
  failed += 1
}
function pass(msg) {
  console.log('OK', msg)
}

async function fetchRaw(base, path, opts = {}) {
  const url = `${base}${path}`
  const t0 = performance.now()
  const res = await fetch(url, { cache: 'no-store', ...opts })
  const text = await res.text()
  const ms = Math.round(performance.now() - t0)
  let json = null
  let parseError = null
  try {
    json = text ? JSON.parse(text) : null
  } catch (e) {
    parseError = e.message
  }
  return { url, status: res.status, ms, text, json, parseError, contentType: res.headers.get('content-type') || '' }
}

function assertJson(host, label, row) {
  if (row.status >= 500) fail(`${host} ${label}: HTTP ${row.status}`)
  if (row.parseError) {
    fail(`${host} ${label}: invalid JSON — ${row.parseError} body=${row.text.slice(0, 120)}`)
    return null
  }
  if (row.json === null && row.text.trim()) {
    fail(`${host} ${label}: non-JSON body`)
    return null
  }
  if (!String(row.contentType).includes('json') && row.json && typeof row.json === 'object') {
    console.warn(`WARN ${host} ${label}: content-type not json (${row.contentType})`)
  }
  pass(`${host} ${label}: HTTP ${row.status} JSON ok (${row.ms}ms)`)
  return row.json
}

function checkChannel(ch, idx, host) {
  const req = ['id', 'name', 'url', 'accessType', 'isActive', 'showInApp']
  for (const k of req) {
    if (!(k in ch)) fail(`${host} channels[${idx}] missing ${k}`)
  }
  if (ch.id != null && typeof ch.id !== 'number' && typeof ch.id !== 'string') {
    fail(`${host} channels[${idx}].id bad type ${typeof ch.id}`)
  }
  if (typeof ch.name !== 'string') fail(`${host} channels[${idx}].name not string`)
  if (ch.accessType != null && !['free', 'premium'].includes(ch.accessType)) {
    fail(`${host} channels[${idx}].accessType=${ch.accessType}`)
  }
}

function checkSubscription(body, host, label) {
  const reqBool = ['active', 'isActive']
  for (const k of reqBool) {
    if (!(k in body) || typeof body[k] !== 'boolean') {
      fail(`${host} ${label} missing/bad boolean ${k}`)
    }
  }
  if (!('expires_at' in body) && !('expiresAt' in body)) {
    fail(`${host} ${label} missing expires_at/expiresAt`)
  }
  if (body.active === false && !Array.isArray(body.plans)) {
    fail(`${host} ${label} inactive but plans not array`)
  }
  if (Array.isArray(body.plans)) {
    for (const [i, p] of body.plans.entries()) {
      if (p.id == null || p.name == null || p.price == null) {
        fail(`${host} ${label} plans[${i}] missing id/name/price`)
      }
      if (typeof p.price !== 'number' || Number.isNaN(p.price)) {
        fail(`${host} ${label} plans[${i}].price not number`)
      }
    }
  }
  const gateKeys = ['playbackAllowed', 'playbackGateReason', 'free_mode', 'emergency_mode']
  for (const k of gateKeys) {
    if (!(k in body)) fail(`${host} ${label} missing ${k}`)
  }
}

function checkCheckout(body, host) {
  if (body?.ok !== true) fail(`${host} checkout-providers ok!==true`)
  if (!('payment_provider' in body)) fail(`${host} checkout-providers missing payment_provider`)
  for (const k of ['zenopay', 'sonicpesa', 'auraxpay']) {
    if (typeof body[k] !== 'boolean') fail(`${host} checkout-providers ${k} not boolean`)
  }
}

function checkPlans(plans, host) {
  if (!Array.isArray(plans) || plans.length === 0) {
    fail(`${host} plans empty or not array`)
    return
  }
  for (const [i, p] of plans.entries()) {
    if (p.id == null || !p.name || p.price == null) fail(`${host} plans[${i}] incomplete`)
  }
}

function checkUpdateCheck(body, host, v) {
  if (!body || typeof body !== 'object') {
    fail(`${host} update-check v${v} not object`)
    return
  }
  if (!('decision' in body)) fail(`${host} update-check v${v} missing decision`)
  if (body.decision != null && typeof body.decision !== 'string') {
    fail(`${host} update-check v${v} decision not string`)
  }
}

function checkSettingsPublic(body, host) {
  if (!body?.whatsapp) fail(`${host} settings/public missing whatsapp`)
  if (!body?.popup) fail(`${host} settings/public missing popup`)
}

async function auditHost(host) {
  console.log(`\n========== ${host} ==========`)

  const channels = assertJson(host, 'GET /api/channels', await fetchRaw(host, '/api/channels'))
  if (Array.isArray(channels)) {
    pass(`${host} channels count=${channels.length}`)
    if (channels[0]) checkChannel(channels[0], 0, host)
  }

  const statusPath = `/api/subscription-status?device_id=${encodeURIComponent(PROBE)}&version_code=19`
  const status = assertJson(host, 'GET /api/subscription-status', await fetchRaw(host, statusPath))
  if (status) checkSubscription(status, host, 'subscription-status')

  const verify = assertJson(
    host,
    'POST /api/subscription/verify',
    await fetchRaw(host, '/api/subscription/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        device_id: `${PROBE}_post`,
        version_code: 19,
        version_name: '1.8.1',
      }),
    }),
  )
  if (verify) checkSubscription(verify, host, 'subscription/verify')

  const checkout = assertJson(
    host,
    'GET /api/payments/checkout-providers',
    await fetchRaw(host, '/api/payments/checkout-providers'),
  )
  if (checkout) checkCheckout(checkout, host)

  const plans = assertJson(host, 'GET /api/plans', await fetchRaw(host, '/api/plans'))
  if (plans) checkPlans(plans, host)

  for (const v of VERSIONS) {
    const uc = assertJson(
      host,
      `GET /api/update-check?v${v}`,
      await fetchRaw(host, `/api/update-check?version_code=${v}`),
    )
    if (uc) checkUpdateCheck(uc, host, v)
  }

  const settings = assertJson(
    host,
    'GET /api/settings/public',
    await fetchRaw(host, '/api/settings/public'),
  )
  if (settings) checkSettingsPublic(settings, host)

  return { channels, status, verify, checkout, plans, settings }
}

function compareParity(vps, render) {
  console.log('\n========== VPS vs Render parity ==========')
  if (Array.isArray(vps.channels) && Array.isArray(render.channels)) {
    if (vps.channels.length !== render.channels.length) {
      fail(`channel count mismatch VPS=${vps.channels.length} Render=${render.channels.length}`)
    } else pass(`channel count match (${vps.channels.length})`)
    const vk = Object.keys(vps.channels[0] || {}).sort().join(',')
    const rk = Object.keys(render.channels[0] || {}).sort().join(',')
    if (vk !== rk) fail(`channel key shape differs VPS=[${vk}] Render=[${rk}]`)
    else pass('channel object keys match')
  }
  for (const field of ['active', 'isActive', 'playbackAllowed', 'free_mode']) {
    if (vps.status?.[field] !== render.status?.[field] && typeof vps.status?.[field] !== typeof render.status?.[field]) {
      fail(`subscription-status ${field} type mismatch`)
    }
  }
  pass('subscription-status core fields parity checked')
  if (Array.isArray(vps.status?.plans) && Array.isArray(render.status?.plans)) {
    if (vps.status.plans.length !== render.status.plans.length) {
      fail(`verify plans count VPS=${vps.status.plans.length} Render=${render.status.plans.length}`)
    } else pass(`inactive plans count match (${vps.status.plans.length})`)
  }
}

async function stressErrors(host) {
  console.log(`\n========== Error shape ${host} ==========`)
  const bad = await fetchRaw(host, '/api/subscription-status')
  if (bad.status === 400 && bad.json?.error) pass(`${host} subscription-status missing device_id returns JSON error`)
  else if (bad.status >= 500) fail(`${host} subscription-status no device_id => HTTP ${bad.status}`)
  const nf = await fetchRaw(host, '/api/no-such-endpoint-audit')
  if (nf.status === 404) pass(`${host} unknown route HTTP 404`)
  if (nf.parseError && nf.text.trim().startsWith('<')) {
    fail(`${host} 404 returned HTML not JSON (can crash strict parsers)`)
  }
}

console.log('API crash-safety audit')
console.log('VPS:', VPS)
console.log('Render:', RENDER)

const vpsData = await auditHost(VPS)
const renderData = await auditHost(RENDER)
compareParity(vpsData, renderData)
await stressErrors(VPS)
await stressErrors(RENDER)

console.log('\n========== SUMMARY ==========')
if (failed > 0) {
  console.error(`${failed} issue(s) found — backend may contribute to crashes`)
  process.exit(1)
}
console.log('All contract checks passed — responses are valid JSON with expected fields')
