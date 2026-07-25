#!/usr/bin/env node
/**
 * Pre/post safety snapshot: subscription + payment counts (read-only).
 *   node server/scripts/subscription-safety-snapshot.mjs
 */
const API = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const TOKEN = String(process.env.ADMIN_TOKEN || '3030').trim()

async function admin(path) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'X-Admin-Token': TOKEN },
    cache: 'no-store',
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

const health = await fetch(`${API}/api/health`).then((r) => r.json())
const cutover = await admin('/api/runtime/cutover-status')
const falseExpired = await admin('/api/runtime/subscription-false-expired-audit')
const usersSummary = await admin('/api/users/summary').catch(() => ({ status: 0, body: null }))

const out = {
  captured_at: new Date().toISOString(),
  commit: health.commit,
  health_ok: health.ok === true,
  active_device_subscriptions: cutover.body?.active_device_subscriptions ?? null,
  false_expired_affected: falseExpired.body?.affected_count ?? null,
  users_summary: usersSummary.body ?? null,
  pool_ready: cutover.body?.pool_ready === true,
}
console.log(JSON.stringify(out, null, 2))
