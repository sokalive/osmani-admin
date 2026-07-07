#!/usr/bin/env node
/**
 * Users / Subscriptions phone lookup operational UI regression.
 * Run: node server/scripts/test-users-lookup-operational.mjs
 */
import {
  isCanonicalOperationalDeviceId,
  isSyntheticForensicDeviceId,
  lookupAdminUserHistory,
} from '../src/lib/adminUserLookup.js'
import { mapOperationalSubscriptionRow } from '../src/lib/adminUsersList.js'

const checks = []
function assert(name, ok, detail = '') {
  checks.push({ name, ok, detail })
}

assert('synthetic direct-probe excluded', isSyntheticForensicDeviceId('direct-probe-458f2c58'))
assert('synthetic verify-probe excluded', isSyntheticForensicDeviceId('verify-probe-1782539888494'))
assert('synthetic verify-guard excluded', isSyntheticForensicDeviceId('verify-guard-VPS-961960'))
assert(
  'canonical 64-char accepted',
  isCanonicalOperationalDeviceId('4fce58117943a0b5a8607a5fb5e2eb8b292637c5c8989af41eef03f8f3bdd9a1'),
)
assert('short legacy id rejected', !isCanonicalOperationalDeviceId('840446757bec23ac'))
assert('synthetic rejected as canonical', !isCanonicalOperationalDeviceId('direct-probe-458f2c58'))

{
  const row = mapOperationalSubscriptionRow({
    device_id: 'a'.repeat(64),
    status: 'pending',
    started_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    transaction_id: `moved:${'b'.repeat(64)}:osm_sp_test`,
    admin_revoked_at: null,
    provider: 'sonicpesa',
  })
  assert('moved pending not revoked', row.status === 'historical' && row.provider === 'sonicpesa')
}

{
  const row = mapOperationalSubscriptionRow({
    device_id: 'a'.repeat(64),
    status: 'active',
    started_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    transaction_id: 'osm_sp_test',
    admin_revoked_at: new Date().toISOString(),
    provider: 'sonicpesa',
  })
  assert('admin revoke still revoked', row.status === 'revoked')
}

async function liveLookup() {
  const API = process.env.PRODUCTION_API || 'https://api.osmanitv.com'
  const TOKEN = process.env.ADMIN_TOKEN || '3030'
  const res = await fetch(`${API}/api/users/lookup?q=0678089174`, {
    headers: { 'X-Admin-Token': TOKEN },
    cache: 'no-store',
  })
  const body = await res.json()
  const ids = (body.devices || []).map((d) => d.device_id)
  assert('live phone lookup returns devices', ids.length >= 1, `count=${ids.length}`)
  assert(
    'live lookup excludes synthetic probe ids',
    !ids.some((id) => isSyntheticForensicDeviceId(id)),
    ids.join(', '),
  )
  assert(
    'live lookup only canonical ids',
    ids.every((id) => isCanonicalOperationalDeviceId(id)),
    ids.join(', '),
  )
  const bad = ids.filter((id) => !isCanonicalOperationalDeviceId(id))
  assert('no direct-probe in live', !ids.some((id) => String(id).startsWith('direct-probe')), bad.join(','))
}

if (process.env.DATABASE_URL) {
  const local = await lookupAdminUserHistory('0678089174')
  const ids = (local?.devices || []).map((d) => d.device_id)
  assert('db lookup excludes synthetics', !ids.some((id) => isSyntheticForensicDeviceId(id)), ids.join(','))
} else {
  await liveLookup()
}

for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
}
const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
if (failed.length) process.exit(1)
