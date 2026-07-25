#!/usr/bin/env node
/**
 * Live activation timing probe for plan tex (1000 TZS / 3 days).
 * Does initiate a real SonicPesa STK — owner must approve on phone.
 *
 *   node server/scripts/live-activation-timing-probe.mjs
 */
const API = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const PHONE = String(process.env.TEST_PHONE || '+255678089174').trim()
const PLAN_ID = Number(process.env.TEST_PLAN_ID || 9)
const DEVICE_ID = String(
  process.env.TEST_DEVICE_ID || `live_act_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
).trim()

async function sseSnapshot(deviceId, ms = 8000) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), ms)
  try {
    const res = await fetch(`${API}/api/subscription-stream?device_id=${encodeURIComponent(deviceId)}`, {
      headers: { Accept: 'text/event-stream' },
      signal: ac.signal,
    })
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const m = buf.match(/event: snapshot\ndata: ([^\n]+)/)
      if (m) return JSON.parse(m[1])
    }
    return null
  } finally {
    clearTimeout(t)
    try {
      ac.abort()
    } catch {}
  }
}

async function verify(deviceId) {
  const res = await fetch(`${API}/api/subscription/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: deviceId }),
  })
  return res.json()
}

async function status(orderId) {
  const res = await fetch(`${API}/api/payments/sonicpesa/status/${encodeURIComponent(orderId)}`, {
    cache: 'no-store',
  })
  return { http: res.status, body: await res.json().catch(() => null) }
}

const health = await fetch(`${API}/api/health`).then((r) => r.json())
console.log(JSON.stringify({ step: 'health', commit: health.commit, ok: health.ok }))

const createT0 = Date.now()
const createRes = await fetch(`${API}/api/payments/sonicpesa/create-order`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    deviceId: DEVICE_ID,
    device_id: DEVICE_ID,
    phone: PHONE,
    planId: PLAN_ID,
    plan_id: PLAN_ID,
  }),
})
const createBody = await createRes.json().catch(() => null)
const createMs = Date.now() - createT0
console.log(
  JSON.stringify({
    step: 'create-order',
    http: createRes.status,
    ms: createMs,
    code: createBody?.code,
    orderId: createBody?.orderId,
    body: createBody,
  }),
)

if (createRes.status === 409 && createBody?.code === 'ACTIVE_SUBSCRIPTION_EXISTS') {
  console.log(JSON.stringify({ step: 'blocked_active', ok: true }))
  process.exit(0)
}

if (!createRes.ok || !createBody?.orderId) {
  console.error('create-order failed')
  process.exit(1)
}

const orderId = createBody.orderId
const deadline = Date.now() + 120_000
let activatedAt = null
let last = null
while (Date.now() < deadline) {
  last = await status(orderId)
  const v = await verify(DEVICE_ID)
  const active = v.active === true
  const elapsed = Date.now() - createT0
  console.log(
    JSON.stringify({
      step: 'poll',
      elapsed_ms: elapsed,
      txn_status: last.body?.status ?? last.body?.transaction?.status ?? null,
      waiting: last.body?.waiting_state ?? last.body?.app_waiting_state ?? null,
      verify_active: active,
      expiresAt: v.expiresAt,
      remaining_days: v.remaining_days,
      expiry_policy: v.expiry_policy,
    }),
  )
  if (active) {
    activatedAt = elapsed
    break
  }
  await new Promise((r) => setTimeout(r, 500))
}

const sse = await sseSnapshot(DEVICE_ID)
const report = {
  deviceId: DEVICE_ID,
  orderId,
  phone: PHONE,
  planId: PLAN_ID,
  create_ms: createMs,
  activation_ms: activatedAt,
  activation_under_2s: activatedAt != null && activatedAt <= 2000,
  final_verify: await verify(DEVICE_ID),
  sse_active: sse?.active === true,
  sse_remaining_days: sse?.remaining_days ?? null,
  last_status: last,
}
console.log(JSON.stringify(report, null, 2))
process.exit(activatedAt != null ? 0 : 2)
