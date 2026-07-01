#!/usr/bin/env node
/**
 * Live production API parity audit + repair.
 *   cd server && node scripts/production-subscription-parity.mjs
 *   cd server && node scripts/production-subscription-parity.mjs --repair
 */
const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const RENDER = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/+$/, '')
const TOKEN = String(process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '3030').trim()
const EXAMPLE = String(process.env.EXAMPLE_DEVICE || 'c0972049aa5f862e').trim()
const doRepair = process.argv.includes('--repair')

async function call(base, method, path, body) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      'X-Admin-Token': TOKEN,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${base} ${method} ${path} HTTP ${res.status}: ${JSON.stringify(json)}`)
  return json
}

async function probeDevice(base, label, deviceId) {
  const status = await fetch(`${base}/api/subscription-status?device_id=${encodeURIComponent(deviceId)}`, {
    cache: 'no-store',
  }).then((r) => r.json())
  const verify = await fetch(`${base}/api/subscription/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: deviceId }),
    cache: 'no-store',
  }).then((r) => r.json())
  return {
    label,
    commit: (await fetch(`${base}/api/health`, { cache: 'no-store' }).then((r) => r.json())).commit,
    status_active: status.active === true,
    verify_active: verify.active === true,
    status_exp: status.expires_at,
    verify_exp: verify.expires_at,
    status_rem: status.remaining_seconds,
    verify_rem: verify.remaining_seconds,
    mismatch: status.active !== verify.active || status.expires_at !== verify.expires_at,
  }
}

async function main() {
  console.log('=== BEFORE PARITY AUDIT (VPS) ===')
  const before = await call(VPS, 'GET', '/runtime/subscription-api-parity-audit')
  console.log(JSON.stringify(before.counts, null, 2))

  if (doRepair) {
    console.log('\n=== REPAIR (stepped) ===')
    const steps = [
      ['false-expired', () => call(VPS, 'POST', '/runtime/subscription-false-expired-repair?dry_run=0&confirm=1')],
      ['wrong-direction', () => call(VPS, 'POST', '/runtime/subscription-wrong-direction-repair?dry_run=0&confirm=1&limit=25')],
      ['duplicate-phone', () => call(VPS, 'POST', '/runtime/subscription-duplicate-phone-repair?dry_run=0&confirm=1')],
      ['shadow', () => call(VPS, 'POST', '/runtime/subscription-shadow-repair-batch?shadow_limit=25&orphan_limit=10')],
    ]
    for (const [name, fn] of steps) {
      try {
        const r = await fn()
        console.log(name, JSON.stringify(r.counts || r.repaired_count || r.remaining_clusters || r.after || r))
      } catch (e) {
        console.warn(name, 'failed:', e.message)
      }
    }
    for (let i = 0; i < 5; i++) {
      try {
        const dup = await call(VPS, 'POST', '/runtime/subscription-duplicate-phone-repair?dry_run=0&confirm=1')
        console.log(`duplicate-phone round ${i + 1} remaining=${dup.remaining_clusters} repaired=${dup.repaired_count}`)
        if ((dup.remaining_clusters ?? 0) === 0) break
        if ((dup.repaired_count ?? 0) === 0) break
      } catch (e) {
        break
      }
    }
  }

  console.log('\n=== AFTER PARITY AUDIT (VPS) ===')
  const after = await call(VPS, 'GET', '/runtime/subscription-api-parity-audit')
  console.log(JSON.stringify(after.counts, null, 2))

  console.log(`\n=== EXAMPLE DEVICE ${EXAMPLE} ===`)
  const vps = await probeDevice(VPS, 'VPS', EXAMPLE)
  const render = await probeDevice(RENDER, 'Render', EXAMPLE)
  console.log(JSON.stringify({ vps, render }, null, 2))

  const pass =
    after.counts.false_expired === 0 &&
    after.counts.wrong_direction_victims === 0 &&
    after.counts.migration_shadows === 0 &&
    after.counts.restoration_unresolved === 0 &&
    after.counts.duplicate_phone_clusters === 0 &&
    after.counts.entitled_non_active_non_moved === 0 &&
    after.counts.api_mismatch_sampled === 0 &&
    vps.status_active &&
    vps.verify_active &&
    render.status_active &&
    render.verify_active &&
    !vps.mismatch &&
    !render.mismatch

  console.log('\nPASS', pass)
  process.exit(pass ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
