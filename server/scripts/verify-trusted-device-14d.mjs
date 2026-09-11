/**
 * Controlled 14-day trusted-device expiration verification (no global clock change).
 * Sets trusted_expires_at on a disposable test row (or dry-runs helpers) without printing secrets.
 *
 * Usage (on VPS with DATABASE_URL loaded):
 *   node server/scripts/verify-trusted-device-14d.mjs
 *   VERIFY_TRUST_DEVICE_ID=<uuid> VERIFY_TRUST_USER_ID=<uuid> node server/scripts/verify-trusted-device-14d.mjs
 */
import assert from 'node:assert/strict'
import {
  TRUSTED_DEVICE_TTL_DAYS,
  TRUSTED_DEVICE_TTL_SECONDS,
  isTrustedDeviceActive,
  isTrustedDeviceExpired,
  trustedExpiresAtFrom,
  deriveStatus,
} from '../src/adminAuthStore.js'

const results = []

function pass(name, detail) {
  results.push({ name, ok: true, detail })
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`)
}

function fail(name, detail) {
  results.push({ name, ok: false, detail })
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  assert.equal(TRUSTED_DEVICE_TTL_DAYS, 14)
  assert.equal(TRUSTED_DEVICE_TTL_SECONDS, 336 * 3600)
  pass('ttl_constants', '14 days = 336 hours = 1209600 seconds')

  const t0 = new Date('2026-01-01T00:00:00.000Z')
  const exp = trustedExpiresAtFrom(t0)
  assert.equal(exp.toISOString(), '2026-01-15T00:00:00.000Z')
  pass('expires_at_math', `${t0.toISOString()} + 14d = ${exp.toISOString()}`)

  const future = {
    trusted: true,
    blocked: false,
    status: 'ACTIVE',
    force_otp_next: false,
    revoked_at: null,
    trusted_expires_at: new Date(Date.now() + 60_000),
  }
  assert.equal(isTrustedDeviceExpired(future), false)
  assert.equal(isTrustedDeviceActive(future), true)
  pass('before_expiration', 'device remains ACTIVE')

  const past = { ...future, trusted_expires_at: new Date(Date.now() - 1000) }
  assert.equal(isTrustedDeviceExpired(past), true)
  assert.equal(isTrustedDeviceActive(past), false)
  assert.equal(deriveStatus(past), 'EXPIRED')
  pass('after_expiration', 'device becomes EXPIRED; not active')

  const deviceId = String(process.env.VERIFY_TRUST_DEVICE_ID || '').trim()
  const userId = String(process.env.VERIFY_TRUST_USER_ID || '').trim()
  if (deviceId && userId && process.env.DATABASE_URL) {
    const { getPool } = await import('../src/db/pool.js')
    const { setTrustedDeviceExpiresAtForTest } = await import('../src/adminAuthStore.js')
    const pool = getPool()
    if (!pool) throw new Error('DATABASE_URL pool unavailable')

    const before = await setTrustedDeviceExpiresAtForTest(
      deviceId,
      userId,
      new Date(Date.now() + 14 * 86400 * 1000),
    )
    assert.ok(before?.id)
    pass('db_set_future_expires', `device ${deviceId.slice(0, 8)}… expires in 14d`)

    const expired = await setTrustedDeviceExpiresAtForTest(
      deviceId,
      userId,
      new Date(Date.now() - 1000),
    )
    assert.ok(expired?.trusted_expires_at)
    assert.equal(isTrustedDeviceExpired(expired), true)
    pass('db_set_past_expires', 'controlled timestamp expiry without changing system clock')

    // Restore a valid future window so we do not leave the owner locked out mid-test.
    await setTrustedDeviceExpiresAtForTest(deviceId, userId, new Date(Date.now() + 14 * 86400 * 1000))
    pass('db_restore_future', 'test device trust window restored to +14d')
  } else {
    pass('db_skip', 'VERIFY_TRUST_DEVICE_ID/USER_ID not set — helper-only checks ran')
  }

  const failed = results.filter((r) => !r.ok)
  if (failed.length) {
    console.error(JSON.stringify({ ok: false, results }, null, 2))
    process.exit(1)
  }
  console.log(JSON.stringify({ ok: true, results }, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
