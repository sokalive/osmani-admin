#!/usr/bin/env node
/**
 * Production manual gift incident — fetch investigation + optional repair.
 * Usage: ADMIN_TOKEN=3030 node server/scripts/final-manual-gift-production-investigation.mjs
 */
const BASE = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const TOKEN = String(process.env.ADMIN_TOKEN || '3030').trim()
const REPAIR = String(process.env.REPAIR || '').trim() === '1'

async function get(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'X-Admin-Token': TOKEN },
    cache: 'no-store',
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

async function post(path, body = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': TOKEN },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

async function main() {
  const health = await get('/api/health')
  console.log('health.commit', health.body?.commit)

  const inv = await get('/api/runtime/manual-gift-production-investigation')
  if (inv.status !== 200) {
    console.error('investigation failed', inv.status, inv.body)
    process.exit(1)
  }
  console.log(JSON.stringify(inv.body, null, 2))

  if (REPAIR) {
    const stale = await post('/api/runtime/manual-gift-repair')
    console.log('stale_repair', stale.body)
    const testing = await post('/api/runtime/manual-gift-repair-testing')
    console.log('testing_repair', testing.body)
    const after = await get('/api/runtime/manual-gift-production-investigation')
    console.log('after.stats', after.body?.audit_stats)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
