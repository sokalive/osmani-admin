#!/usr/bin/env node
/**
 * Verify push notification endpoints + OneSignal health on Render and VPS.
 * Usage: node server/scripts/verify-notifications-push-live.mjs
 */
const RENDER_API = String(process.env.RENDER_API_BASE || 'https://osmani-admin-api.onrender.com').replace(
  /\/$/,
  '',
)
const VPS_API = String(process.env.VPS_API_BASE || 'https://api.osmanitv.com').replace(/\/$/, '')
const TOKEN = process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '3030'

const checks = []

function pass(host, name, detail) {
  checks.push({ host, name, ok: true, detail })
  console.log(`PASS [${host}] ${name}: ${detail}`)
}

function fail(host, name, detail) {
  checks.push({ host, name, ok: false, detail })
  console.error(`FAIL [${host}] ${name}: ${detail}`)
}

async function fetchJson(base, path, opts = {}) {
  const t0 = performance.now()
  const res = await fetch(`${base}${path}`, {
    cache: 'no-store',
    ...opts,
    headers: {
      'X-Admin-Token': TOKEN,
      ...(opts.headers || {}),
    },
  })
  const ms = Math.round(performance.now() - t0)
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { res, body, ms, text }
}

async function probeHost(label, base) {
  const health = await fetchJson(base, '/api/health')
  if (health.res.ok && health.body?.ok) {
    pass(label, 'health', `${health.res.status} ${health.ms}ms commit=${String(health.body.commit || '').slice(0, 7)}`)
  } else {
    fail(label, 'health', `HTTP ${health.res.status}`)
  }

  const runtime = await fetchJson(base, '/api/notifications/runtime?audience=all')
  const count = Array.isArray(runtime.body?.notifications)
    ? runtime.body.notifications.length
    : Array.isArray(runtime.body?.messages)
      ? runtime.body.messages.length
      : 0
  if (runtime.res.ok && count >= 0) {
    pass(label, 'notifications/runtime', `${runtime.res.status} ${runtime.ms}ms rows=${count}`)
  } else {
    fail(label, 'notifications/runtime', `HTTP ${runtime.res.status}`)
  }

  const diag = await fetchJson(base, '/api/notifications/onesignal-diagnostics')
  if (!diag.res.ok || !diag.body?.configured) {
    fail(label, 'onesignal-configured', diag.body?.error || `HTTP ${diag.res.status}`)
    return
  }
  const messageable = Number(diag.body?.app?.messageable_players ?? 0)
  const segment = Number(diag.body?.subscribedUsersSegment?.subscriber_count ?? 0)
  const appId = String(diag.body?.appId ?? '')
  const hasPushChannel = diag.body?.backendBroadcastRequest?.body?.target_channel === 'push'
  pass(
    label,
    'onesignal-diagnostics',
    `messageable=${messageable} segment=${segment} app=${appId.slice(0, 8)}… push_channel=${hasPushChannel}`,
  )
  if (messageable < 100) {
    fail(label, 'onesignal-audience', `low messageable_players=${messageable}`)
  }

  const adminList = await fetchJson(base, '/api/notifications')
  if (!adminList.res.ok || !Array.isArray(adminList.body)) {
    fail(label, 'notifications-admin', `HTTP ${adminList.res.status}`)
    return
  }
  const latest = adminList.body.find((n) => n.kind === 'admin' && n.status === 'sent' && n.onesignalId)
  if (latest) {
    pass(
      label,
      'latest-admin-push',
      `delivered=${latest.onesignalDelivered ?? '?'} failed=${latest.onesignalFailed ?? '?'} id=${String(latest.onesignalId).slice(0, 8)}…`,
    )
  } else {
    fail(label, 'latest-admin-push', 'no sent admin push with onesignal id')
  }
}

async function main() {
  console.log('=== Notification push verification ===')
  await probeHost('render', RENDER_API)
  await probeHost('vps', VPS_API)

  const failed = checks.filter((c) => !c.ok)
  console.log('\n=== Summary ===', { total: checks.length, failed: failed.length })
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
