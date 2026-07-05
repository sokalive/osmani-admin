#!/usr/bin/env node
/**
 * Admin subscription revocation safety tests (static + optional live VPS).
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

const usersJs = fs.readFileSync(path.join(__dirname, '../src/routes/users.js'), 'utf8')
const billingJs = fs.readFileSync(path.join(__dirname, '../src/billingStore.js'), 'utf8')
const subJs = fs.readFileSync(path.join(__dirname, '../src/routes/subscription.js'), 'utf8')
const cacheJs = fs.readFileSync(path.join(__dirname, '../src/lib/subscriptionAccessCache.js'), 'utf8')
const usersPage = fs.readFileSync(path.join(__dirname, '../../src/pages/UsersPage.jsx'), 'utf8')

assert('users revoke route', usersJs.includes('/revoke'))
assert('users preserve transactions', usersJs.includes('transactions_preserved'))
assert('no cascade delete in users route', !usersJs.includes('deleteDeviceUserCascade'))
assert('tryFinalize blocks admin revoke', billingJs.includes('admin_revoked_order_blocked'))
assert('upsert clears revoke fields', billingJs.includes('admin_revoked_at = NULL'))
assert('isAccessRowActive checks revoked', subJs.includes("status === 'revoked'"))
assert('remaining_seconds requires active status', billingJs.includes("WHEN ds.status = 'active' AND ds.expires_at"))
assert('cache sanitize respects revoked', cacheJs.includes('admin_revoked_at'))
assert('search button in UI', usersPage.includes('runSearchNow') && usersPage.includes('Search'))
assert('revoke UX wording', usersPage.includes('Revoke subscription'))

assert(
  'block same order replay',
  isAdminRevokedOrderBlocked(
    { admin_revoked_at: new Date(), admin_revoked_transaction_id: 'order_a' },
    'order_a',
  ) === true,
)
assert(
  'allow new order after revoke',
  isAdminRevokedOrderBlocked(
    { admin_revoked_at: new Date(), admin_revoked_transaction_id: 'order_a' },
    'order_b',
  ) === false,
)

async function liveChecks() {
  const API = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
  const TOKEN = String(process.env.ADMIN_TOKEN || '3030').trim()
  async function admin(path, opts = {}) {
    const res = await fetch(`${API}${path}`, {
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
  const metrics = await admin('/api/runtime/sonicpesa-reliability-metrics?days=30')
  assert('critical=0', metrics.body?.critical_unresolved_completed === 0)
}

await liveChecks().catch((e) => assert('live checks', false, e.message))

const failed = checks.filter((c) => !c.ok)
for (const c of checks.filter((x) => x.ok)) console.log(`PASS ${c.name}${c.detail ? ` (${c.detail})` : ''}`)
for (const c of failed) console.error(`FAIL ${c.name}${c.detail ? ` (${c.detail})` : ''}`)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
process.exit(failed.length ? 1 : 0)
