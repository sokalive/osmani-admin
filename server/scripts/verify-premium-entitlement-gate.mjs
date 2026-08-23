/**
 * Server-side premium entitlement enforcement tests.
 *
 * Unit (always):
 *   node scripts/verify-premium-entitlement-gate.mjs
 *
 * Live (optional):
 *   SECURITY_TEST_BASE_URL=https://api.osmanitv.com node scripts/verify-premium-entitlement-gate.mjs
 *
 * Does NOT modify payment logic or production subscription rows for paid users.
 * Uses synthetic device_ids that have no entitlement.
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
  channelRequiresPremiumEntitlement,
  PREMIUM_DENY_REASONS,
  PREMIUM_ALLOW_REASONS,
  redactPremiumChannelUrls,
  premiumEnforcementMode,
} from '../src/lib/playbackEntitlementGate.js'
import { createPlaybackGrant, verifyPlaybackGrant } from '../src/lib/playbackGrant.js'

const BASE = String(process.env.SECURITY_TEST_BASE_URL || '').replace(/\/$/, '')
const USE_LIVE = Boolean(BASE)

function synthDevice(prefix) {
  return crypto.createHash('sha256').update(`${prefix}:${Date.now()}:${crypto.randomUUID()}`).digest('hex').slice(0, 32)
}

console.log('==> Unit: premium channel detection')
assert.equal(channelRequiresPremiumEntitlement({ accessType: 'premium' }), true)
assert.equal(channelRequiresPremiumEntitlement({ accessType: 'free' }), false)
assert.equal(channelRequiresPremiumEntitlement({ channelKind: 'instruction_video' }), false)
assert.equal(channelRequiresPremiumEntitlement({ accessPremium: true }), true)
console.log('PASS  channelRequiresPremiumEntitlement')

console.log('==> Unit: URL redaction strips playback fields')
{
  const redacted = redactPremiumChannelUrls(
    {
      id: 1,
      name: 'Test',
      accessType: 'premium',
      url: 'https://evil.example/stream',
      playbackUrl: 'https://evil.example/stream',
      stream_url: 'https://evil.example/stream',
      proxy_playback_url: 'https://api/stream-proxy?url=x',
      direct_stream_url: 'https://api/stream-direct?token=x',
    },
    PREMIUM_DENY_REASONS.NO_ACTIVE_SUBSCRIPTION,
  )
  assert.equal(redacted.url, '')
  assert.equal(redacted.playbackUrl, '')
  assert.equal(redacted.proxy_playback_url, '')
  assert.equal(redacted.access_denied, true)
  assert.equal(redacted.access_deny_reason, PREMIUM_DENY_REASONS.NO_ACTIVE_SUBSCRIPTION)
  assert.equal(redacted.name, 'Test')
  console.log('PASS  redactPremiumChannelUrls')
}

console.log('==> Unit: playback grant create + verify + replay binding')
{
  process.env.PLAYBACK_GRANT_SIGNING_SECRET =
    process.env.PLAYBACK_GRANT_SIGNING_SECRET || 'test-playback-grant-secret-32chars!!'
  const g = createPlaybackGrant({ deviceId: 'dev-a', channelId: 1, reason: 'active_subscription' })
  assert.equal(g.ok, true)
  const ok = verifyPlaybackGrant(g.grant, { expectedDeviceId: 'dev-a', expectedChannelId: 1 })
  assert.equal(ok.ok, true)
  const mismatch = verifyPlaybackGrant(g.grant, { expectedDeviceId: 'dev-b' })
  assert.equal(mismatch.ok, false)
  console.log('PASS  playback grant HMAC')
}

console.log('==> Unit: enforcement mode default')
{
  const prev = process.env.SERVER_PREMIUM_ENFORCEMENT
  delete process.env.SERVER_PREMIUM_ENFORCEMENT
  assert.equal(premiumEnforcementMode(), 'enforce')
  process.env.SERVER_PREMIUM_ENFORCEMENT = 'shadow'
  assert.equal(premiumEnforcementMode(), 'shadow')
  if (prev === undefined) delete process.env.SERVER_PREMIUM_ENFORCEMENT
  else process.env.SERVER_PREMIUM_ENFORCEMENT = prev
  console.log('PASS  premiumEnforcementMode')
}

if (!USE_LIVE) {
  console.log('SKIP live tests (set SECURITY_TEST_BASE_URL)')
  console.log('verify-premium-entitlement-gate: OK (unit)')
  process.exit(0)
}

async function get(path, headers = {}) {
  const res = await fetch(`${BASE}${path}`, { headers })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

async function post(path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, body: json }
}

console.log(`==> Live tests against ${BASE}`)

const unpaid = synthDevice('unpaid-premium-gate')

console.log('TEST 2 — unpaid user channels redaction')
{
  const anon = await get('/api/channels')
  assert.equal(anon.status, 200)
  assert.ok(Array.isArray(anon.body))
  const premAnon = anon.body.filter((c) => c.accessType === 'premium' || c.accessPremium)
  assert.ok(premAnon.length > 0, 'expected premium channels in catalog')
  for (const c of premAnon.slice(0, 5)) {
    assert.equal(c.playbackUrl || '', '', `anon premium ${c.id} must redact playbackUrl`)
    assert.equal(c.access_denied, true)
  }
  const free = anon.body.find((c) => c.accessType === 'free' || c.channelKind === 'instruction_video')
  if (free) {
    assert.ok(free.playbackUrl || free.url || free.stream_url, 'free content must remain playable')
  }
  console.log('PASS  TEST 2/8 unpaid + free content')
}

console.log('TEST 4 — fake client premium flag ignored')
{
  const r = await post('/api/playback/authorize', {
    device_id: unpaid,
    isPremium: true,
    premium: true,
    subscriptionActive: true,
    paid: true,
  })
  assert.equal(r.status, 403)
  assert.equal(r.body.allowed, false)
  assert.ok(
    [
      PREMIUM_DENY_REASONS.NO_ACTIVE_SUBSCRIPTION,
      PREMIUM_DENY_REASONS.SUBSCRIPTION_INACTIVE,
      PREMIUM_DENY_REASONS.SUBSCRIPTION_EXPIRED,
    ].includes(r.body.reason) || r.body.reason,
  )
  console.log('PASS  TEST 4 fake premium flags → deny', r.body.reason)
}

console.log('TEST 5 — modified APK simulation (direct premium proxy)')
{
  const channels = await get('/api/channels')
  const prem = channels.body.find((c) => c.accessType === 'premium')
  // Even if attacker knows upstream from elsewhere, open proxy must deny known premium hosts without entitlement
  const knownUpstream = 'https://nur.mpingotv.com/v1/player.php?channel=1'
  const proxy = await fetch(
    `${BASE}/stream-proxy?url=${encodeURIComponent(knownUpstream)}&device_id=${encodeURIComponent(unpaid)}`,
  )
  const proxyBody = await proxy.json().catch(() => ({}))
  assert.equal(proxy.status, 403)
  assert.ok(proxyBody.code || proxyBody.error)
  console.log('PASS  TEST 5 stream-proxy denies unpaid device', proxyBody.code || proxyBody.error)
  void prem
}

console.log('TEST entitlement endpoint')
{
  const r = await get(`/api/playback/entitlement?device_id=${encodeURIComponent(unpaid)}`)
  assert.equal(r.status, 200)
  assert.equal(r.body.allowed, false)
  console.log('PASS  entitlement endpoint', r.body.reason)
}

console.log('verify-premium-entitlement-gate: OK (unit+live unpaid path)')
console.log('NOTE: TEST 1/6 paid-user allow requires an existing active device_id (set PREMIUM_TEST_PAID_DEVICE_ID)')

if (process.env.PREMIUM_TEST_PAID_DEVICE_ID) {
  const paid = String(process.env.PREMIUM_TEST_PAID_DEVICE_ID).trim()
  const auth = await post('/api/playback/authorize', { device_id: paid })
  console.log('TEST 1 paid authorize', auth.status, auth.body.reason || auth.body.error)
  assert.equal(auth.status, 200)
  assert.equal(auth.body.allowed, true)
  assert.ok(auth.body.grant)
  const ch = await get(`/api/channels?device_id=${encodeURIComponent(paid)}`)
  const prem = ch.body.filter((c) => c.accessType === 'premium')
  assert.ok(prem.some((c) => c.playbackUrl), 'paid device must receive premium URLs')
  console.log('PASS  TEST 1 legitimate paid user')
}
