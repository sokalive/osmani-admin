/**
 * One-shot production recovery: migrate active sub onto inactive user device (fixes ping-pong).
 *   cd server && node scripts/fix-shadow-direction-recovery.mjs
 */
const API = String(process.env.API_BASE || 'https://api.osmanitv.com').replace(/\/$/, '')
const TOKEN = process.env.ADMIN_TOKEN || '3030'

async function audit() {
  const res = await fetch(`${API}/api/runtime/subscription-incident-audit`, {
    headers: { 'X-Admin-Token': TOKEN },
    cache: 'no-store',
  })
  return res.json()
}

async function status(deviceId) {
  const res = await fetch(`${API}/api/subscription-status?device_id=${encodeURIComponent(deviceId)}`, {
    cache: 'no-store',
  })
  const body = await res.json().catch(() => ({}))
  return body.active === true && body.blocked !== true
}

async function batch() {
  const res = await fetch(`${API}/api/runtime/subscription-shadow-repair-batch?shadow_limit=50&orphan_limit=10`, {
    method: 'POST',
    headers: { 'X-Admin-Token': TOKEN, 'Content-Type': 'application/json' },
    cache: 'no-store',
  })
  return res.json()
}

const before = await audit()
const pairs = new Map()
for (const row of before.after?.revoked_shadow_devices || before.before?.revoked_shadow_devices || []) {
  const a = String(row.device_id || '').trim()
  const b = String(row.source_device_id || '').trim()
  if (!a || !b) continue
  pairs.set([a, b].sort().join('|'), { a, b, reason: row.match_reason })
}

const plan = []
for (const { a, b, reason } of pairs.values()) {
  const aActive = await status(a)
  const bActive = await status(b)
  if (aActive && bActive) continue
  if (aActive && !bActive) plan.push({ target: b, source: a, reason })
  else if (!aActive && bActive) plan.push({ target: a, source: b, reason })
  else plan.push({ target: a, source: b, reason })
}

console.log('pairs', pairs.size, 'to_migrate', plan.length)
console.log(JSON.stringify({ before_counts: before.counts, plan: plan.slice(0, 5) }, null, 2))

// Use batch endpoint (requires bb781f4+ with direction fix); fall back to reporting plan.
let rounds = 0
let last = null
for (let i = 0; i < 10; i++) {
  rounds += 1
  last = await batch()
  console.log(
    `round ${rounds}: migrated=${last.migrated?.length || 0} failed=${last.failed?.length || 0} remaining=${last.remaining_unique_shadows} shadows=${last.after?.shadows}`,
  )
  if ((last.remaining_unique_shadows ?? 0) === 0 && (last.failed?.length ?? 0) === 0) break
  if ((last.migrated?.length ?? 0) === 0 && (last.failed?.length ?? 0) === 0) break
}

const after = await audit()
console.log(JSON.stringify({ rounds, before: before.counts, after: after.counts, last_batch: last }, null, 2))

const inactiveShadows = []
for (const row of after.after?.revoked_shadow_devices || []) {
  const active = await status(row.device_id)
  if (!active) inactiveShadows.push(row.device_id)
}
console.log('inactive_shadow_devices_after', inactiveShadows.length, inactiveShadows.slice(0, 10))
process.exit(inactiveShadows.length > 0 || (after.counts?.incorrectly_revoked_migration_shadow ?? 0) > 0 ? 1 : 0)
