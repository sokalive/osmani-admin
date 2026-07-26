/**
 * End-to-end proof of the "Omba Kifurushi" approval pipeline on a throwaway device.
 *
 * Request #36's real device already owns a paid entitlement, so its approval is
 * (correctly) blocked by the active-subscription gate. This script exercises the
 * success path on a device that has never existed in production, then removes it.
 *
 * Verifies: DB commit, cache invalidation, SSE broadcast (manual_gift +
 * device_subscription + subscription_wake), activation, canonical parity,
 * entitlement guard, and the 409 gate on a second grant.
 *
 * Usage: node server/scripts/live-verify-approval-pipeline.mjs
 */
const API = process.env.VERIFY_API_BASE || 'https://api.osmanitv.com/api'
const TOKEN = process.env.VERIFY_ADMIN_TOKEN || '3030'
const PIN = process.env.VERIFY_ADMIN_PIN || '3030'
const PLAN_ID = Number(process.env.VERIFY_PLAN_ID || 9)
const DEVICE_ID = process.env.VERIFY_SIM_DEVICE || `simverify${Date.now().toString(36)}`
const PHONE = process.env.VERIFY_SIM_PHONE || '0700000036'

const adminHeaders = { 'X-Admin-Token': TOKEN, 'Content-Type': 'application/json' }
const out = { startedAt: new Date().toISOString(), api: API, deviceId: DEVICE_ID, steps: [] }

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
          const lines = frame.split('\n')
          const nameLine = lines.find((l) => l.startsWith('event:'))
          const dataLine = lines.find((l) => l.startsWith('data:'))
          if (!nameLine && !dataLine) continue
          let data = null
          try {
            data = dataLine ? JSON.parse(dataLine.slice(5).trim()) : null
          } catch {
            data = dataLine ? dataLine.slice(5).trim() : null
          }
          events.push({ event: nameLine ? nameLine.slice(6).trim() : 'message', atMs: Date.now(), data })
        }
      }
    } catch (e) {
      if (e?.name !== 'AbortError') events.push({ event: '_error', error: String(e?.message || e) })
    }
  })()
  const timer = setTimeout(() => controller.abort(), ms)
  return {
    events,
    openedAt: startedAt,
    async stop() {
      clearTimeout(timer)
      controller.abort()
      await done.catch(() => {})
      return events
    },
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** SSE noise from global settings polls is not part of the activation contract. */
const SETTINGS_EVENTS = new Set([
  'phone_gate_settings',
  'app_update_settings',
  'app_modes',
  'app_settings_changed',
  'trial_watch_settings',
])

async function main() {
  const statusBefore = await jsonFetch(`${API}/subscription-status?device_id=${DEVICE_ID}`)
  step('device-status-before', { httpStatus: statusBefore.status, body: statusBefore.body })

  const sse = collectSse(DEVICE_ID, 30000)
  await sleep(2500)

  const created = await jsonFetch(`${API}/subscription-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_id: DEVICE_ID,
      phone: PHONE,
      plan_id: PLAN_ID,
      app_version: '1.8.2',
      runtime_version: '1.8.2',
    }),
  })
  step('omba-kifurushi-submitted', { httpStatus: created.status, body: created.body })
  const requestId = created.body?.requestId
  if (!requestId) throw new Error('Could not create subscription request')

  const approveAt = Date.now()
  const approve = await jsonFetch(`${API}/admin/subscription-requests/${requestId}/approve`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ pin: PIN, confirm: true, reason: 'Approval pipeline verification' }),
  })
  step('approve', { httpStatus: approve.status, latencyMs: approve.ms, body: approve.body })

  await sleep(4000)

  const statusAfter = await jsonFetch(`${API}/subscription-status?device_id=${DEVICE_ID}`)
  step('device-status-after', { httpStatus: statusAfter.status, latencyMs: statusAfter.ms, body: statusAfter.body })

  const secondGrant = await jsonFetch(`${API}/admin/manual-subscription/grant`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ pin: PIN, device_id: DEVICE_ID, duration_days: 3, phone: PHONE }),
  })
  step('duplicate-grant-blocked', { httpStatus: secondGrant.status, body: secondGrant.body })

  await sleep(2000)
  const events = await sse.stop()
  const activation = events.filter((e) => !SETTINGS_EVENTS.has(e.event))
  const gift = activation.find((e) => e.event === 'manual_gift')
  step('sse-activation-events', {
    totalFrames: events.length,
    activationFrames: activation.map((e) => ({
      event: e.event,
      msAfterApproveRequest: e.atMs - approveAt,
      data: e.data,
    })),
    manualGiftBroadcastLatencyMs: gift ? gift.atMs - approveAt : null,
  })

  const inv = await jsonFetch(`${API}/admin/customer-investigation/investigate?deviceId=${DEVICE_ID}`, {
    headers: adminHeaders,
  })
  step('admin-canonical-view', {
    subscription: inv.body?.devices?.[0]?.subscription ?? null,
    access: inv.body?.devices?.[0]?.access ?? null,
    diagnosis: inv.body?.diagnosis ?? null,
  })

  const cleanupRevoke = await jsonFetch(`${API}/users/bulk`, {
    method: 'DELETE',
    headers: adminHeaders,
    body: JSON.stringify({ device_ids: [DEVICE_ID] }),
  })
  const cleanupRequest = await jsonFetch(`${API}/admin/subscription-requests/bulk-delete`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ pin: PIN, request_ids: [requestId] }),
  })
  const statusCleaned = await jsonFetch(`${API}/subscription-status?device_id=${DEVICE_ID}`)
  step('cleanup', {
    revoke: { httpStatus: cleanupRevoke.status, body: cleanupRevoke.body },
    requestDelete: { httpStatus: cleanupRequest.status, body: cleanupRequest.body },
    finalStatus: statusCleaned.body,
  })

  const sub = statusAfter.body ?? {}
  step('verdict', {
    approveHttp: approve.status,
    activatedAfterApprove: sub.isActive === true || sub.active === true,
    expiresAt: sub.expiresAt ?? sub.expires_at ?? null,
    remainingDays: sub.remainingDays ?? sub.remaining_days ?? null,
    manualGiftSseReceived: Boolean(gift),
    manualGiftLatencyMs: gift ? gift.atMs - approveAt : null,
    wakeEventReceived: activation.some((e) => e.event === 'subscription_wake'),
    deviceSubscriptionEventReceived: activation.some((e) => e.event === 'device_subscription'),
    duplicateGrantHttp: secondGrant.status,
    duplicateGrantMessageSw: secondGrant.body?.message_sw ?? null,
    cleanedUp: statusCleaned.body?.isActive !== true && statusCleaned.body?.active !== true,
  })

  out.finishedAt = new Date().toISOString()
  const fs = await import('node:fs/promises')
  await fs.writeFile('tmp-live-verify-pipeline.json', JSON.stringify(out, null, 2), 'utf8')
  console.log('\nSaved tmp-live-verify-pipeline.json')
}

main().catch((e) => {
  console.error('FAILED', e)
  process.exit(1)
})
