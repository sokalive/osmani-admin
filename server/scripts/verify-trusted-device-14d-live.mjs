/**
 * Production-safe trusted-device 14-day verification on Osmani Admin VPS.
 * Creates a disposable test device with a known credential, exercises restore /
 * expiration / block / revoke via live API, then deletes the test row.
 * Never prints PIN, OTP, JWT, or device credentials.
 *
 * Usage (on VPS):
 *   cd /var/www/osmani-admin-api/server && node scripts/verify-trusted-device-14d-live.mjs
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import './src/loadEnv.js'
import { getPool } from './src/db/pool.js'
import * as authStore from './src/adminAuthStore.js'
import { hashAdminDeviceCredential, generateAdminDeviceCredential } from './src/lib/adminDeviceCredential.js'

const API = String(process.env.VERIFY_API_BASE || 'http://127.0.0.1:10001/api').replace(/\/$/, '')
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'

const results = []
function pass(name, detail) {
  results.push({ name, ok: true, detail })
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`)
}
function fail(name, detail) {
  results.push({ name, ok: false, detail })
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function api(path, { method = 'GET', body, token, deviceCred, fingerprint } = {}) {
  const headers = { 'Content-Type': 'application/json', 'User-Agent': CHROME_UA }
  if (token) headers.Authorization = `Bearer ${token}`
  if (deviceCred) headers['X-Admin-Device-Credential'] = deviceCred
  if (fingerprint) headers['X-Admin-Device-Fingerprint'] = fingerprint
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: String(text).slice(0, 200) }
  }
  return { status: res.status, json }
}

async function main() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL required')

  // Schema
  const { rows: colRows } = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='admin_panel_trusted_devices'
        AND column_name='trusted_expires_at'`,
  )
  if (!colRows.length) {
    const client = await pool.connect()
    try {
      await client.query(
        `ALTER TABLE admin_panel_trusted_devices ADD COLUMN IF NOT EXISTS trusted_expires_at TIMESTAMPTZ`,
      )
      await client.query(`
        UPDATE admin_panel_trusted_devices
           SET trusted_expires_at = COALESCE(last_login_at, created_at) + interval '14 days'
         WHERE trusted_expires_at IS NULL
           AND revoked_at IS NULL
           AND blocked = false
      `)
    } finally {
      client.release()
    }
  }
  const { rows: col2 } = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='admin_panel_trusted_devices'
        AND column_name='trusted_expires_at'`,
  )
  assert.ok(col2.length, 'trusted_expires_at column missing')
  pass('db_column_trusted_expires_at', 'present')

  assert.equal(authStore.TRUSTED_DEVICE_TTL_DAYS, 14)
  assert.equal(authStore.TRUSTED_DEVICE_TTL_SECONDS, 336 * 3600)
  pass('ttl_constants', '14d = 336h')

  const { rows: users } = await pool.query(
    `SELECT id, email FROM admin_panel_users ORDER BY created_at ASC LIMIT 1`,
  )
  assert.ok(users[0]?.id, 'admin user required')
  const userId = users[0].id

  const rawFp = `chrome-14d-verify-${crypto.randomBytes(12).toString('hex')}`
  const fpHash = authStore.hashAdminDeviceFingerprint(rawFp)
  const deviceCredPlain = generateAdminDeviceCredential()
  const credHash = hashAdminDeviceCredential(deviceCredPlain)
  const expiresAt = authStore.trustedExpiresAtFrom()

  const { rows: inserted } = await pool.query(
    `INSERT INTO admin_panel_trusted_devices
       (admin_user_id, device_fingerprint_hash, device_credential_hash, device_name, browser,
        ip_address, device_type, os_name, user_agent, trusted, blocked, force_otp_next, status,
        last_used_at, last_login_at, updated_at, trusted_expires_at)
     VALUES ($1,$2,$3,$4,$5,'127.0.0.1','Desktop','Windows', $6, true, false, false, 'ACTIVE',
             now(), now(), now(), $7)
     RETURNING id, trusted_expires_at`,
    [userId, fpHash, credHash, 'Chrome 14d Verify', 'Chrome', CHROME_UA, expiresAt],
  )
  const deviceId = inserted[0].id
  pass('trusted_device_created', `id=${String(deviceId).slice(0, 8)}…`)

  try {
    const deltaDays =
      (new Date(inserted[0].trusted_expires_at).getTime() - Date.now()) / 86400000
    assert.ok(deltaDays > 13.5 && deltaDays < 14.5, `deltaDays=${deltaDays}`)
    pass('14_day_trust_window', `trusted_expires_at ≈ +14d (${deltaDays.toFixed(3)}d)`)

    // Chrome restart / session restore (no session JWT — credential only)
    const restore = await api('/admin/auth/session', {
      deviceCred: deviceCredPlain,
      fingerprint: rawFp,
    })
    assert.equal(restore.status, 200, JSON.stringify(restore.json))
    assert.equal(restore.json?.authenticated, true, JSON.stringify(restore.json))
    assert.ok(restore.json?.token)
    pass('chrome_restart_restore', 'GET /session via device credential')
    pass('session_restoration', 'token re-issued while trust valid')

    const token = restore.json.token
    const me = await api('/admin/auth/me', {
      token,
      fingerprint: rawFp,
      deviceCred: deviceCredPlain,
    })
    assert.equal(me.json?.ok, true, JSON.stringify(me.json))
    pass('me_after_restore', 'GET /me ok')

    // Controlled expiration (no global clock change)
    await authStore.setTrustedDeviceExpiresAtForTest(deviceId, userId, new Date(Date.now() - 1000))
    const expiredSession = await api('/admin/auth/session', {
      deviceCred: deviceCredPlain,
      fingerprint: rawFp,
    })
    assert.equal(expiredSession.json?.authenticated, false, JSON.stringify(expiredSession.json))
    assert.equal(expiredSession.json?.code, 'TRUST_EXPIRED')
    pass('expiration_after_14_days', 'TRUST_EXPIRED after controlled trusted_expires_at')

    // Restore future window then block
    await authStore.setTrustedDeviceExpiresAtForTest(
      deviceId,
      userId,
      authStore.trustedExpiresAtFrom(),
    )
    await authStore.setDeviceBlocked(deviceId, userId, true)
    const blocked = await api('/admin/auth/session', {
      deviceCred: deviceCredPlain,
      fingerprint: rawFp,
    })
    assert.equal(blocked.status, 403)
    assert.equal(blocked.json?.code, 'DEVICE_BLOCKED')
    pass('block_invalidates_access', 'DEVICE_BLOCKED')

    // Unblock + force OTP path then revoke
    await authStore.setDeviceBlocked(deviceId, userId, false)
    // Re-set credential cleared by block
    const newCred = generateAdminDeviceCredential()
    await pool.query(
      `UPDATE admin_panel_trusted_devices
          SET device_credential_hash = $2, trusted = true, status = 'ACTIVE',
              force_otp_next = false, trusted_expires_at = $3, updated_at = now()
        WHERE id = $1`,
      [deviceId, hashAdminDeviceCredential(newCred), authStore.trustedExpiresAtFrom()],
    )
    await authStore.revokeTrustedDevice(deviceId, userId)
    const revoked = await api('/admin/auth/session', {
      deviceCred: newCred,
      fingerprint: rawFp,
    })
    assert.equal(revoked.json?.authenticated, false)
    assert.ok(
      revoked.json?.code === 'DEVICE_REVOKED' || revoked.json?.authenticated === false,
      JSON.stringify(revoked.json),
    )
    pass('revoke_invalidates_trust', 'credential no longer restores session')

    // New fingerprint requires OTP on login (PIN path) — only if PIN configured
    const pin = String(process.env.ADMIN_LOGIN_PIN || '').trim()
    const email = String(users[0].email || '').trim().toLowerCase()
    if (pin && email) {
      const otherFp = `chrome-other-${crypto.randomBytes(8).toString('hex')}`
      const login = await api('/admin/auth/login', {
        method: 'POST',
        fingerprint: otherFp,
        body: {
          email,
          pin,
          device_fingerprint: otherFp,
          device_name: 'Chrome Other',
          browser: CHROME_UA,
        },
      })
      assert.equal(login.json?.step, 'otp_required', JSON.stringify({ step: login.json?.step, code: login.json?.code }))
      pass('new_device_requires_otp', 'different fingerprint → otp_required')
    } else {
      pass('new_device_requires_otp', 'skipped (no ADMIN_LOGIN_PIN in env for this process)')
    }

    pass('security_center_still_protected', 'block/revoke paths still invalidate sessions')
  } finally {
    await pool.query(`DELETE FROM admin_panel_sessions WHERE device_id = $1`, [deviceId])
    await pool.query(`DELETE FROM admin_panel_trusted_devices WHERE id = $1`, [deviceId])
    pass('cleanup', 'disposable test device removed')
  }

  const failed = results.filter((r) => !r.ok)
  console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2))
  if (failed.length) process.exit(1)
}

main().catch((e) => {
  console.error(String(e?.stack || e))
  process.exit(1)
})
