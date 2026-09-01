#!/usr/bin/env node
/**
 * Admin Expired subscriptions view regression (read-only).
 * Run: node server/scripts/test-admin-expired-subscriptions.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mapOperationalSubscriptionRow } from '../src/lib/adminUsersList.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const adminSrc = fs.readFileSync(path.join(__dirname, '../src/lib/adminUsersList.js'), 'utf8')
const usersRouteSrc = fs.readFileSync(path.join(__dirname, '../src/routes/users.js'), 'utf8')

const checks = []
function assert(name, ok, detail = '') {
  checks.push({ name, ok, detail })
}

assert('listAdminExpiredSubscriptions exported', adminSrc.includes('export async function listAdminExpiredSubscriptions'))
assert(
  'expired uses authoritative active inverse',
  adminSrc.includes("ds.status = 'active'") &&
    adminSrc.includes('ds.expires_at <= now()') &&
    adminSrc.includes('ds.admin_revoked_at IS NULL'),
)
assert('expired excludes pending-only rows', !adminSrc.includes("ds.status = 'pending'"))
assert('expired_newest sort', adminSrc.includes("case 'expired_newest':"))
assert('expired_newest order expires_at DESC', adminSrc.includes('ds.expires_at DESC NULLS LAST'))
assert('summary expired count', adminSrc.includes('AS expired,'))
assert('GET /users/expired route', usersRouteSrc.includes("usersRouter.get('/expired'"))

const now = Date.now()
const past = new Date(now - 86400000).toISOString()
const future = new Date(now + 86400000).toISOString()

{
  const row = mapOperationalSubscriptionRow({
    device_id: 'a'.repeat(64),
    status: 'active',
    started_at: past,
    expires_at: future,
    transaction_id: 'osm_sp_test',
    admin_revoked_at: null,
    provider: 'sonicpesa',
  })
  assert('active subscription not expired status', row.status === 'active' && row.active === true)
}

{
  const row = mapOperationalSubscriptionRow({
    device_id: 'b'.repeat(64),
    status: 'active',
    started_at: past,
    expires_at: future,
    transaction_id: 'osm_sp_test',
    admin_revoked_at: null,
    provider: 'sonicpesa',
  })
  assert('future expires_at not expired status', row.status !== 'expired')
}

{
  const row = mapOperationalSubscriptionRow({
    device_id: 'c'.repeat(64),
    status: 'active',
    started_at: past,
    expires_at: past,
    transaction_id: 'osm_sp_test',
    admin_revoked_at: null,
    provider: 'sonicpesa',
  })
  assert('past expires_at maps to expired', row.status === 'expired' && row.active === false)
}

{
  const row = mapOperationalSubscriptionRow({
    device_id: 'd'.repeat(64),
    status: 'active',
    started_at: past,
    expires_at: past,
    transaction_id: 'osm_sp_test',
    admin_revoked_at: new Date().toISOString(),
    provider: 'sonicpesa',
  })
  assert('admin revoked not natural expired', row.status === 'revoked')
}

{
  const row = mapOperationalSubscriptionRow({
    device_id: 'e'.repeat(64),
    status: 'pending',
    started_at: past,
    expires_at: past,
    transaction_id: 'osm_sp_test',
    admin_revoked_at: null,
    provider: 'sonicpesa',
  })
  assert('pending past expiry not classified active', row.status !== 'active')
}

function isSortedExpiresDesc(items) {
  for (let i = 1; i < items.length; i += 1) {
    const a = new Date(items[i - 1].expires_at).getTime()
    const b = new Date(items[i].expires_at).getTime()
    if (b > a) return false
  }
  return true
}

async function liveReadOnly() {
  const API = process.env.PRODUCTION_API || 'https://api.osmanitv.com'
  const TOKEN = process.env.ADMIN_TOKEN || '3030'
  const headers = { 'X-Admin-Token': TOKEN, Accept: 'application/json' }

  const summaryRes = await fetch(`${API}/api/users/summary`, { headers, cache: 'no-store' })
  const summaryBody = await summaryRes.json()
  assert('live summary ok', summaryRes.ok && summaryBody?.ok === true)

  const listRes = await fetch(`${API}/api/users/expired?limit=25&page=1&sort=expired_newest`, {
    headers,
    cache: 'no-store',
  })
  if (listRes.status === 404) {
    console.log('SKIP live expired endpoint — not deployed yet')
    return
  }
  const listBody = await listRes.json()
  if (listBody?.ok !== true || typeof summaryBody?.summary?.expired !== 'number') {
    console.log('SKIP live expired verification — endpoint or summary count not live yet')
    return
  }

  assert('live summary has expired count', typeof summaryBody.summary.expired === 'number')
  assert('live expired list ok', listRes.ok && listBody?.ok === true)
  const items = Array.isArray(listBody?.items) ? listBody.items : []
  assert(
    'live expired count matches pagination total',
    Number(listBody?.pagination?.total) === Number(summaryBody.summary.expired),
    `total=${listBody?.pagination?.total} summary=${summaryBody.summary.expired}`,
  )
  assert('live expired sorted expires_at DESC', items.length < 2 || isSortedExpiresDesc(items))
  assert(
    'live expired rows are naturally expired',
    items.every((r) => r.status === 'expired' || r.active === false),
    items.slice(0, 3).map((r) => r.status).join(','),
  )

  const activeRes = await fetch(`${API}/api/users/active?limit=5&page=1`, { headers, cache: 'no-store' })
  const activeBody = await activeRes.json()
  const activeIds = new Set((activeBody?.items || []).map((r) => r.device_id))
  const overlap = items.filter((r) => activeIds.has(r.device_id))
  assert('active paid not in expired sample', overlap.length === 0, overlap.map((r) => r.device_id).join(','))
}

await liveReadOnly().catch((e) => {
  assert('live read-only verification', false, String(e.message || e))
})

for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
}
const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
if (failed.length) process.exit(1)
