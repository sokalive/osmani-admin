/**
 * Live production verification for subscription request #36 + manual grant gate.
 *
 * Read-only by default except two admin calls the operator explicitly asked for:
 *   1. POST /admin/subscription-requests/36/approve
 *   2. POST /admin/manual-subscription/grant  (same device)
 * Both are protected by the active-subscription gate, so a device that already
 * owns a live entitlement produces HTTP 409 and writes nothing.
 *
 * Usage: node server/scripts/live-verify-request-36.mjs
 */
const API = process.env.VERIFY_API_BASE || 'https://api.osmanitv.com/api'
const TOKEN = process.env.VERIFY_ADMIN_TOKEN || '3030'
const PIN = process.env.VERIFY_ADMIN_PIN || '3030'
const DEVICE_ID = process.env.VERIFY_DEVICE_ID || 'b3edf15c2460e46c'
const REQUEST_ID = Number(process.env.VERIFY_REQUEST_ID || 36)
const PHONE = process.env.VERIFY_PHONE || '0678089174'

const adminHeaders = { 'X-Admin-Token': TOKEN, 'Content-Type': 'application/json' }
const out = { startedAt: new Date().toISOString(), api: API, deviceId: DEVICE_ID, requestId: REQUEST_ID, steps: [] }

function step(name, data) {
  out.steps.push({ name, at: new Date().toISOString(), ...data })
  console.log(`\n=== ${name} ===`)
  console.log(JSON.stringify(data, null, 2))
}

async function jsonFetch(url, init = {}) {
  const started = Date.now()
  const res = await fetch(url, init)
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, ok: res.ok, body, ms: Date.now() - started }
}

async function snapshot(label) {
  const inv = await jsonFetch(`${API}/admin/customer-investigation/investigate?deviceId=${DEVICE_ID}`, {
    headers: adminHeaders,
  })
  const d = inv.body?.devices?.[0] ?? null
  const payments = inv.body?.payments ?? {}
  const summary = {
    label,
    subscription: d?.subscription ?? null,
    access: d?.access ?? null,
    activeSubscriptionRows: (inv.body?.subscriptions?.active ?? []).length,
    completedPayments: (payments.completed ?? []).length,
    pendingPayments: (payments.pending ?? []).length,
    completedOrderIds: (payments.completed ?? []).map((p) => p.order_id),
  }
  return summary
}

/** Collect SSE frames from /subscription-stream for `ms` milliseconds. */
function collectSse(deviceId, ms) {
  const events = []
  const controller = new AbortController()
  const startedAt = Date.now()
  const done = (async () => {
    try {
      const res = await fetch(`${API}/subscription-stream?device_id=${encodeURIComponent(deviceId)}`, {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      })
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done: finished } = await reader.read()
        if (finished) break
        buf += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          const nameLine = frame.split('\n').find((l) => l.startsWith('event:'))
          const dataLine = frame.split('\n').find((l) => l.startsWith('data:'))
          if (!nameLine && !dataLine) continue
          let data = null
          try {
            data = dataLine ? JSON.parse(dataLine.slice(5).trim()) : null
          } catch {
            data = dataLine ? dataLine.slice(5).trim() : null
          }
          events.push({
            event: nameLine ? nameLine.slice(6).trim() : 'message',
            atMsFromOpen: Date.now() - startedAt,
            data,
          })
        }
      }
    } catch (e) {
      if (e?.name !== 'AbortError') events.push({ event: '_error', error: String(e?.message || e) })
    }
  })()
  const timer = setTimeout(() => controller.abort(), ms)
  return {
    events,
    async stop() {
      clearTimeout(timer)
      controller.abort()
      await done.catch(() => {})
      return events
    },
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const health = await jsonFetch(`${API}/health`)
  step('production-health', { status: health.status, commit: health.body?.commit, render: health.body?.startup?.render })

  const before = await snapshot('before')
  step('device-state-before', before)

  const reqBefore = await jsonFetch(`${API}/admin/subscription-requests?limit=200`, { headers: adminHeaders })
  const row36Before = (reqBefore.body?.rows ?? []).find((r) => Number(r.id) === REQUEST_ID) ?? null
  step('request-36-before', { status: row36Before?.status, row: row36Before })

  // SSE listener is opened before the approval so any broadcast is captured live.
  const sse = collectSse(DEVICE_ID, 20000)
  await sleep(2500)

  const approve = await jsonFetch(`${API}/admin/subscription-requests/${REQUEST_ID}/approve`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ pin: PIN, confirm: true, reason: 'Live production verification' }),
  })
  step('approve-request-36', { httpStatus: approve.status, latencyMs: approve.ms, body: approve.body })

  await sleep(2500)

  const grant = await jsonFetch(`${API}/admin/manual-subscription/grant`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ pin: PIN, device_id: DEVICE_ID, duration_days: 3, phone: PHONE }),
  })
  step('manual-grant-same-device', { httpStatus: grant.status, latencyMs: grant.ms, body: grant.body })

  await sleep(3000)
  const events = await sse.stop()
  step('sse-frames', { count: events.length, events })

  const after = await snapshot('after')
  step('device-state-after', after)

  const reqAfter = await jsonFetch(`${API}/admin/subscription-requests?limit=200`, { headers: adminHeaders })
  const row36After = (reqAfter.body?.rows ?? []).find((r) => Number(r.id) === REQUEST_ID) ?? null
  step('request-36-after', { status: row36After?.status, row: row36After })

  const noDuplicates =
    before.activeSubscriptionRows === after.activeSubscriptionRows &&
    before.completedPayments === after.completedPayments &&
    before.subscription?.expires_at === after.subscription?.expires_at

  step('verdict', {
    approveHttp: approve.status,
    approveMessageSw: approve.body?.message_sw ?? null,
    grantHttp: grant.status,
    grantMessageSw: grant.body?.message_sw ?? null,
    expiryBefore: before.subscription?.expires_at ?? null,
    expiryAfter: after.subscription?.expires_at ?? null,
    noDuplicateEntitlement: noDuplicates,
    requestStatusUnchanged: row36Before?.status === row36After?.status,
  })

  out.finishedAt = new Date().toISOString()
  const fs = await import('node:fs/promises')
  await fs.writeFile('tmp-live-verify-36.json', JSON.stringify(out, null, 2), 'utf8')
  console.log('\nSaved tmp-live-verify-36.json')
}

main().catch((e) => {
  console.error('FAILED', e)
  process.exit(1)
})
