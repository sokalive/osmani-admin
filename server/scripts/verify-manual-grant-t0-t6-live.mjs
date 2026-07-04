#!/usr/bin/env node
/**
 * Live T0→T6 manual grant integration harness (production-safe test devices only).
 *
 * Usage:
 *   ADMIN_TOKEN=3030 ADMIN_PIN=3030 node server/scripts/verify-manual-grant-t0-t6-live.mjs
 *   ITERATIONS=10 node server/scripts/verify-manual-grant-t0-t6-live.mjs
 */
import { SUBSCRIPTION_WAKE_SSE_EVENTS, MANUAL_SUBSCRIPTION_SSE_ALIASES } from '../src/lib/manualSubscriptionSseContract.js'

const VPS_API = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const VPS_ADMIN = String(process.env.VPS_ADMIN || 'https://admin.osmanitv.com').replace(/\/+$/, '')
const RENDER_ADMIN = String(process.env.RENDER_ADMIN || 'https://osmani-admin-mpya.onrender.com').replace(
  /\/+$/,
  '',
)
const TOKEN = String(process.env.ADMIN_TOKEN || process.env.APP_UPDATE_ADMIN_TOKEN || '3030').trim()
const PIN = String(process.env.ADMIN_PIN || process.env.ADMIN_SENSITIVE_ACTION_PASSWORD || '3030').trim()
const ITERATIONS = Math.min(20, Math.max(1, Number(process.env.ITERATIONS || 10)))
const DURATION_DAYS = Number(process.env.GRANT_DURATION_DAYS || 7)

const WAKE_EVENTS = new Set([...SUBSCRIPTION_WAKE_SSE_EVENTS, ...MANUAL_SUBSCRIPTION_SSE_ALIASES, 'device_subscription'])

let failed = 0

function fail(msg) {
  console.error(`FAIL ${msg}`)
  failed += 1
}

function ok(msg) {
  console.log(`OK ${msg}`)
}

function pct(sorted, p) {
  if (!sorted.length) return null
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[idx]
}

function stats(values) {
  const s = [...values].sort((a, b) => a - b)
  return {
    n: s.length,
    min: s[0] ?? null,
    median: pct(s, 50),
    p95: pct(s, 95),
    max: s[s.length - 1] ?? null,
  }
}

async function adminFetch(base, path, opts = {}) {
  const t0 = Date.now()
  const res = await fetch(`${base}${path}`, {
    cache: 'no-store',
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Token': TOKEN,
      ...(opts.headers || {}),
    },
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body, ms: Date.now() - t0 }
}

async function verifyDevice(deviceId) {
  const t0 = Date.now()
  const res = await fetch(`${VPS_API}/api/subscription/verify`, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: deviceId }),
  })
  const body = await res.json().catch(() => ({}))
  return { ms: Date.now() - t0, body, status: res.status }
}

function parseSseChunk(chunk, state) {
  state.buf += chunk
  const parts = state.buf.split('\n\n')
  state.buf = parts.pop() ?? ''
  for (const block of parts) {
    if (!block.trim() || block.startsWith(':')) continue
    let event = 'message'
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data += line.slice(5).trim()
    }
    if (data) {
      let parsed = data
      try {
        parsed = JSON.parse(data)
      } catch {
        /* keep string */
      }
      state.events.push({ event, data: parsed, at: Date.now() })
    }
  }
}

async function openSse(deviceId, untilMs = 45_000) {
  const state = { buf: '', events: [] }
  const ac = new AbortController()
  const res = await fetch(`${VPS_API}/api/subscription-stream?device_id=${encodeURIComponent(deviceId)}`, {
    headers: { Accept: 'text/event-stream' },
    signal: ac.signal,
  })
  if (!res.ok || !res.body) throw new Error(`SSE open failed HTTP ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const deadline = Date.now() + untilMs

  const pump = (async () => {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read()
      if (done) break
      parseSseChunk(decoder.decode(value, { stream: true }), state)
    }
  })()

  return {
    state,
    close: () => {
      ac.abort()
      reader.cancel().catch(() => {})
    },
    waitForWake: async (afterMs, timeoutMs = 15_000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const hit = state.events.find((e) => e.at >= afterMs && WAKE_EVENTS.has(e.event))
        if (hit) return hit
        await new Promise((r) => setTimeout(r, 50))
      }
      return null
    },
    pump,
  }
}

async function grantViaApi(base, label, deviceId, phone) {
  const t0 = Date.now()
  const res = await adminFetch(base, '/api/admin/manual-subscription/grant', {
    method: 'POST',
    body: JSON.stringify({
      device_id: deviceId,
      duration_days: DURATION_DAYS,
      phone: phone || '+255700000001',
      pin: PIN,
    }),
  })
  return { ...res, t0, t1: Date.now() }
}

async function deleteGrant(grantId) {
  const res = await adminFetch(VPS_API, `/api/admin/manual-subscription/history/${grantId}`, {
    method: 'DELETE',
    body: JSON.stringify({ security_pin: PIN, pin: PIN }),
  })
  return res
}

async function runIteration(i, adminBase, adminLabel) {
  const deviceId = `verify_sse_t0_${Date.now()}_${i}`
  const phone = `+2557${String(Date.now()).slice(-8)}`
  const sse = await openSse(deviceId)
  const pumpPromise = sse.pump

  const t0 = Date.now()
  const grant = await grantViaApi(adminBase, adminLabel, deviceId, phone)
  const t1 = grant.t1

  if (grant.status !== 200 || !grant.body?.ok) {
    sse.close()
    fail(`${adminLabel} iter ${i} grant HTTP ${grant.status} ${grant.body?.error || ''}`)
    return null
  }

  const grantId = grant.body.grantId
  const wake = await sse.waitForWake(t0, 12_000)
  const t3 = wake?.at ?? null

  let t4 = null
  let verify = null
  for (let attempt = 0; attempt < 40; attempt++) {
    verify = await verifyDevice(deviceId)
    if (verify.body?.active === true) {
      t4 = Date.now()
      break
    }
    await new Promise((r) => setTimeout(r, 100))
  }

  const t5 = verify?.body?.manualGift?.showPopup ? t4 : null
  const t6 = verify?.body?.playbackAllowed === true ? t4 : null

  sse.close()
  await pumpPromise.catch(() => {})

  if (!wake) fail(`${adminLabel} iter ${i} no SSE wake within 12s`)
  else ok(`${adminLabel} iter ${i} SSE event=${wake.event} grantId=${grantId}`)

  if (!verify?.body?.active) fail(`${adminLabel} iter ${i} verify not active`)
  if (!verify?.body?.playbackAllowed) fail(`${adminLabel} iter ${i} playbackAllowed false`)
  if (!verify?.body?.manualGift?.showPopup) fail(`${adminLabel} iter ${i} manualGift missing`)

  await deleteGrant(grantId).catch(() => {})

  return {
    adminLabel,
    grantId,
    deviceId_masked: `${deviceId.slice(0, 12)}…`,
    t0,
    t1,
    t2: t3,
    t3,
    t4,
    t5,
    t6,
    admin_to_db_ms: t1 - t0,
    db_to_sse_ms: t3 != null ? t3 - t1 : null,
    sse_to_verify_ms: t3 != null && t4 != null ? t4 - t3 : null,
    admin_to_gift_ms: t5 != null ? t5 - t0 : null,
    admin_to_playback_ms: t6 != null ? t6 - t0 : null,
    wake_event: wake?.event ?? null,
  }
}

async function testFifoAck(deviceId) {
  ok('FIFO test uses existing device with stacked gifts if available — read-only ack probes skipped unless GRANT_FIFO_DEVICE set')
  const fifoDevice = String(process.env.GRANT_FIFO_DEVICE || '').trim()
  if (!fifoDevice) return
  let v1 = await verifyDevice(fifoDevice)
  const g1 = v1.body?.manualGift?.grantId
  if (!g1) {
    ok(`FIFO device ${fifoDevice.slice(0, 12)}… no pending gift`)
    return
  }
  const ack1 = await fetch(`${VPS_API}/api/subscription/acknowledge-manual-gift`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: fifoDevice, manual_gift_ack_key: String(g1) }),
  })
  if (!ack1.ok) fail(`FIFO ack grant ${g1} failed`)
  else ok(`FIFO ack grant ${g1}`)
  const v2 = await verifyDevice(fifoDevice)
  const g2 = v2.body?.manualGift?.grantId
  if (g2 && g2 !== g1) ok(`FIFO next gift grantId=${g2}`)
  else if (!g2) ok('FIFO queue empty after ack')
}

async function main() {
  console.log(`\n=== T0→T6 live harness (${ITERATIONS} iterations) ===\n`)
  const health = await fetch(`${VPS_API}/api/health`).then((r) => r.json())
  ok(`VPS health commit=${health.commit}`)

  const rows = []
  for (let i = 0; i < ITERATIONS; i++) {
    rows.push(await runIteration(i, VPS_API, 'VPS-API'))
    if (i === 0) rows.push(await runIteration(i + 1000, VPS_API, 'Render-path-via-VPS-API'))
  }

  const valid = rows.filter(Boolean)
  const report = {
    iterations: valid.length,
    admin_to_db: stats(valid.map((r) => r.admin_to_db_ms)),
    db_to_sse: stats(valid.map((r) => r.db_to_sse_ms).filter((x) => x != null)),
    sse_to_verify: stats(valid.map((r) => r.sse_to_verify_ms).filter((x) => x != null)),
    admin_to_gift: stats(valid.map((r) => r.admin_to_gift_ms).filter((x) => x != null)),
    admin_to_playback: stats(valid.map((r) => r.admin_to_playback_ms).filter((x) => x != null)),
    samples: valid.slice(0, 3),
  }
  console.log('\nSLO stats:', JSON.stringify(report, null, 2))

  if (report.db_to_sse.p95 != null && report.db_to_sse.p95 > 1000) {
    fail(`DB→SSE p95 ${report.db_to_sse.p95}ms > 1000ms target`)
  } else if (report.db_to_sse.p95 != null) {
    ok(`DB→SSE p95 ${report.db_to_sse.p95}ms`)
  }

  if (report.sse_to_verify.p95 != null && report.sse_to_verify.p95 > 1000) {
    fail(`SSE→verify p95 ${report.sse_to_verify.p95}ms > 1000ms target`)
  } else if (report.sse_to_verify.p95 != null) {
    ok(`SSE→verify p95 ${report.sse_to_verify.p95}ms`)
  }

  if (report.admin_to_playback.p95 != null && report.admin_to_playback.p95 > 2000) {
    fail(`Admin→playback p95 ${report.admin_to_playback.p95}ms > 2000ms target`)
  } else if (report.admin_to_playback.p95 != null) {
    ok(`Admin→playback p95 ${report.admin_to_playback.p95}ms`)
  }

  await testFifoAck()

  console.log(`\n=== Done (${failed} failures) ===\n`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
