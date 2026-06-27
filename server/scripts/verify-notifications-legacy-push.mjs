#!/usr/bin/env node
/**
 * Production verification: legacy (Render) + v24 (VPS) push cohorts after image URL fix.
 *
 * Sends real test notifications (text-only + image) via VPS admin API (shared OneSignal app).
 * Usage: node server/scripts/verify-notifications-legacy-push.mjs
 */
const RENDER_API = String(process.env.RENDER_API_BASE || 'https://osmani-admin-api.onrender.com').replace(
  /\/$/,
  '',
)
const VPS_API = String(process.env.VPS_API_BASE || 'https://api.osmanitv.com').replace(/\/$/, '')
const TOKEN = process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '3030'
const SEND_LIVE = process.env.SEND_LIVE !== '0'

const report = {
  time: new Date().toISOString(),
  hosts: {},
  sends: [],
  pass: true,
}

function fail(msg) {
  report.pass = false
  console.error(`FAIL ${msg}`)
}

function pass(msg) {
  console.log(`PASS ${msg}`)
}

async function fetchJson(base, path, opts = {}) {
  const res = await fetch(`${base}${path}`, {
    cache: 'no-store',
    ...opts,
    headers: {
      'X-Admin-Token': TOKEN,
      ...(opts.headers || {}),
    },
  })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { res, body }
}

async function probeHost(label, base) {
  const health = await fetchJson(base, '/api/health')
  const commit = String(health.body?.commit || '').slice(0, 12)
  if (!health.res.ok) {
    fail(`${label} health HTTP ${health.res.status}`)
    return null
  }
  pass(`${label} health commit=${commit}`)
  const diag = await fetchJson(base, '/api/notifications/onesignal-diagnostics')
  const messageable = Number(diag.body?.app?.messageable_players ?? 0)
  report.hosts[label] = { commit, messageable, configured: Boolean(diag.body?.configured) }
  if (!diag.body?.configured) {
    fail(`${label} OneSignal not configured`)
    return null
  }
  pass(`${label} OneSignal messageable=${messageable}`)
  return diag.body
}

async function preparePushImage(base) {
  const tinyJpeg = Buffer.from(
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGf/AP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Cf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Cf//Z',
    'base64',
  )
  const form = new FormData()
  form.append('image', new Blob([tinyJpeg], { type: 'image/jpeg' }), 'legacy-push-test.jpg')
  const res = await fetch(`${base}/api/notifications/prepare-image`, {
    method: 'POST',
    headers: { 'X-Admin-Token': TOKEN },
    body: form,
  })
  const body = await res.json().catch(() => ({}))
  return { res, body }
}

async function sendTestNotification(base, { title, message, image, label }) {
  const payload = {
    title,
    message,
    status: 'sent',
    destination: { type: 'home' },
    ...(image ? { image } : {}),
  }
  const { res, body } = await fetchJson(base, '/api/notifications', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const entry = {
    label,
    httpStatus: res.status,
    onesignalId: body?.onesignalId ?? body?.payload?.onesignal_id ?? null,
    recipients: body?.onesignalRecipients ?? body?.payload?.onesignal_recipients ?? null,
    pushImageUrl: body?.payload?.onesignal_push_image_url ?? null,
    imageSkipped: body?.payload?.onesignal_image_skipped ?? null,
    apiHost: body?.payload?.onesignal_api_host ?? null,
    error: body?.error || body?.message || null,
  }
  report.sends.push(entry)
  if (!res.ok || !entry.onesignalId) {
    fail(`${label}: HTTP ${res.status} ${entry.error || ''}`)
    return entry
  }
  pass(
    `${label}: onesignal=${String(entry.onesignalId).slice(0, 8)}… recipients=${entry.recipients} image=${entry.pushImageUrl ? 'yes' : 'no'} skipped=${entry.imageSkipped}`,
  )
  return entry
}

async function headImage(url) {
  if (!url) return false
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' })
    return res.ok
  } catch {
    return false
  }
}

async function main() {
  console.log('=== Legacy + v24 push verification ===\n')
  await probeHost('render', RENDER_API)
  await probeHost('vps', VPS_API)

  const stamp = new Date().toISOString().slice(11, 19)
  if (!SEND_LIVE) {
    console.log('SEND_LIVE=0 — skipping live sends')
    process.exit(0)
  }

  const textSend = await sendTestNotification(VPS_API, {
    label: 'all-users-text',
    title: `Push fix text ${stamp}`,
    message: 'Legacy v16–v23 + v24 text-only delivery test. Tap to dismiss.',
  })

  const prep = await preparePushImage(VPS_API)
  if (!prep.res.ok || !prep.body?.pushImageUrl) {
    fail(`prepare-image failed HTTP ${prep.res.status}`)
  } else {
    const pushUrl = prep.body.pushImageUrl
    if (pushUrl.includes('api.osmanitv.com')) pass(`pushImageUrl uses VPS origin: ${pushUrl.slice(0, 80)}…`)
    else fail(`pushImageUrl must use VPS origin, got: ${pushUrl}`)

    const headOk = await headImage(pushUrl)
    if (headOk) pass('push image HEAD 200 on VPS origin')
    else fail(`push image HEAD failed: ${pushUrl}`)

    await sendTestNotification(VPS_API, {
      label: 'all-users-image',
      title: `Push fix image ${stamp}`,
      message: 'Legacy v16–v23 + v24 image delivery test. Tap to dismiss.',
      image: prep.body.imageForDb,
    })
  }

  if (textSend?.onesignalId) {
    await new Promise((r) => setTimeout(r, 12_000))
    const list = await fetchJson(VPS_API, '/api/notifications')
    const row = Array.isArray(list.body)
      ? list.body.find((n) => n.onesignalId === textSend.onesignalId)
      : null
    if (row) {
      pass(
        `text send stats: delivered=${row.onesignalDelivered ?? '?'} failed=${row.onesignalFailed ?? '?'} api_host=${row.payload?.onesignal_api_host ?? 'n/a'}`,
      )
    }
  }

  console.log('\n=== Summary ===')
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.pass ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
