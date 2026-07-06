#!/usr/bin/env node
/**
 * Control-plane realtime + search regression checks (static + optional live VPS).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isAdminRevokedOrderBlocked } from '../src/lib/adminSubscriptionRevocation.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const checks = []
function assert(name, ok, detail = '') {
  checks.push({ name, ok, detail })
}

const root = path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')

assert('device subscription relay exists', read('src/lib/deviceSubscriptionRelay.js').includes('osmani_device_subscription'))
assert('relay wired in index', read('src/index.js').includes('wireDeviceSubscriptionRelay'))
assert('lookup endpoint', read('src/routes/users.js').includes("usersRouter.get('/lookup'"))
assert('admin user lookup lib', read('src/lib/adminUserLookup.js').includes('lookupAdminUserHistory'))
assert('admin revoked SSE contract', read('src/lib/manualSubscriptionSseContract.js').includes('writeAdminRevokedSseEvents'))
assert('subscription revoked handler', read('src/routes/subscription.js').includes('subscriptionRevokedSyncHandler'))
assert('rowToPublicStatus admin_revoked', read('src/routes/subscription.js').includes("inactive_reason: inactiveReason"))
assert('channel patch in catalog', read('src/lib/channelCatalogSync.js').includes('channelPatch'))
assert('search revision in UI', read('../src/pages/UsersPage.jsx').includes('searchRevision'))
assert('getUsersLookup api', read('../src/lib/api.js').includes('getUsersLookup'))
assert('exact phone fast path', read('src/lib/adminUsersList.js').includes('dpr_eq'))
assert(
  'block same order replay',
  isAdminRevokedOrderBlocked(
    { admin_revoked_at: new Date(), admin_revoked_transaction_id: 'order_a' },
    'order_a',
  ) === true,
)

async function liveChecks() {
  const API = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
  const TOKEN = String(process.env.ADMIN_TOKEN || '3030').trim()
  async function admin(p, opts = {}) {
    const res = await fetch(`${API}${p}`, {
      cache: 'no-store',
      ...opts,
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': TOKEN, ...(opts.headers || {}) },
    })
    const body = await res.json().catch(() => null)
    return { status: res.status, body }
  }
  const health = await fetch(`${API}/api/health`).then((r) => r.json())
  assert('vps health', health.ok === true, String(health.commit || '').slice(0, 12))

  const t0 = Date.now()
  const search = await admin('/api/users/active?search=255&page=1&limit=5')
  assert('users search 200', search.status === 200, `${Date.now() - t0}ms`)

  const lookup = await admin('/api/users/lookup?q=0000000000000000000000000000000000000000000000000000000000000000')
  assert('lookup route', lookup.status === 200 || lookup.status === 404, String(lookup.status))

  const metrics = await admin('/api/runtime/sonicpesa-reliability-metrics?days=30')
  assert('critical=0', metrics.body?.critical_unresolved_completed === 0)
}

await liveChecks().catch((e) => assert('live checks', false, e.message))

const failed = checks.filter((c) => !c.ok)
for (const c of checks.filter((x) => x.ok)) console.log(`PASS ${c.name}${c.detail ? ` (${c.detail})` : ''}`)
for (const c of failed) console.error(`FAIL ${c.name}${c.detail ? ` (${c.detail})` : ''}`)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
process.exit(failed.length ? 1 : 0)
