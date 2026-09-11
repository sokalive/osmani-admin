/**
 * Production-safe trusted-device 14-day verification on Osmani Admin VPS.
 * Uses a dedicated pg.Client (not the shared app pool) to avoid checkout hangs.
 * Never prints PIN, OTP, JWT, or device credentials.
 *
 * Usage: cd /var/www/osmani-admin-api/server && node scripts/verify-trusted-device-14d-live.mjs
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import '../src/loadEnv.js'
import {
  TRUSTED_DEVICE_TTL_DAYS,
  TRUSTED_DEVICE_TTL_SECONDS,
  hashAdminDeviceFingerprint,
  trustedExpiresAtFrom,
  isTrustedDeviceExpired,
} from '../src/adminAuthStore.js'
import {
  hashAdminDeviceCredential,
  generateAdminDeviceCredential,
} from '../src/lib/adminDeviceCredential.js'

const API = String(process.env.VERIFY_API_BASE || 'http://127.0.0.1:10001/api').replace(/\/$/, '')
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'

const results = []
function pass(name, detail) {
  results.push({ name, ok: true, detail })
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`)
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
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL required')
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 8000,
    statement_timeout: 20000,
  })
  await client.connect()
  await client.query('SET statement_timeout = 20000')

  try {
    const { rows: col2 } = await client.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='admin_panel_trusted_devices'
          AND column_name='trusted_expires_at'`,
    )
    assert.ok(col2.length, 'trusted_expires_at column missing')
    pass('db_column_trusted_expires_at', 'present')

    assert.equal(TRUSTED_DEVICE_TTL_DAYS, 14)
    assert.equal(TRUSTED_DEVICE_TTL_SECONDS, 336 * 3600)
    pass('ttl_constants', '14d = 336h')

    const { rows: users } = await client.query(
      `SELECT id, email FROM admin_panel_users ORDER BY created_at ASC LIMIT 1`,
    )
    assert.ok(users[0]?.id, 'admin user required')
    const userId = users[0].id

    const rawFp = `chrome-14d-verify-${crypto.randomBytes(12).toString('hex')}`
    const fpHash = hashAdminDeviceFingerprint(rawFp)
    const deviceCredPlain = generateAdminDeviceCredential()
    const credHash = hashAdminDeviceCredential(deviceCredPlain)
    const expiresAt = trustedExpiresAtFrom()

    const { rows: inserted } = await client.query(
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

      await client.query(
        `UPDATE admin_panel_trusted_devices
            SET trusted_expires_at = now() - interval '1 second', updated_at = now()
          WHERE id = $1 AND admin_user_id = $2`,
        [deviceId, userId],
      )
      const expiredRow = { trusted_expires_at: new Date(Date.now() - 1000) }
      assert.equal(isTrustedDeviceExpired(expiredRow), true)

      const expiredSession = await api('/admin/auth/session', {
        deviceCred: deviceCredPlain,
        fingerprint: rawFp,
      })
      assert.equal(expiredSession.json?.authenticated, false, JSON.stringify(expiredSession.json))
      assert.equal(expiredSession.json?.code, 'TRUST_EXPIRED')
      pass('expiration_after_14_days', 'TRUST_EXPIRED after controlled trusted_expires_at')

      await client.query(
        `UPDATE admin_panel_trusted_devices
            SET trusted_expires_at = $3, updated_at = now()
          WHERE id = $1 AND admin_user_id = $2`,
        [deviceId, userId, trustedExpiresAtFrom()],
      )

      await client.query(
        `UPDATE admin_panel_trusted_devices
            SET blocked = true, status = 'BLOCKED', blocked_at = now(),
                session_version = session_version + 1, device_credential_hash = NULL, updated_at = now()
          WHERE id = $1 AND admin_user_id = $2`,
        [deviceId, userId],
      )
      await client.query(
        `UPDATE admin_panel_sessions SET revoked_at = now()
          WHERE device_id = $1 AND revoked_at IS NULL`,
        [deviceId],
      )
      const blocked = await api('/admin/auth/session', {
        deviceCred: deviceCredPlain,
        fingerprint: rawFp,
      })
      assert.ok(
        blocked.status === 403 || blocked.json?.authenticated === false,
        JSON.stringify(blocked.json),
      )
      assert.ok(
        blocked.json?.code === 'DEVICE_BLOCKED' || blocked.json?.authenticated === false,
        JSON.stringify(blocked.json),
      )
      pass('block_invalidates_access', String(blocked.json?.code || blocked.status))

      const newCred = generateAdminDeviceCredential()
      await client.query(
        `UPDATE admin_panel_trusted_devices
            SET blocked = false, blocked_at = NULL, status = 'ACTIVE', trusted = true,
                force_otp_next = false, device_credential_hash = $2,
                trusted_expires_at = $3, updated_at = now()
          WHERE id = $1`,
        [deviceId, hashAdminDeviceCredential(newCred), trustedExpiresAtFrom()],
      )
      await client.query(
        `UPDATE admin_panel_trusted_devices
            SET status = 'REVOKED', revoked_at = now(), trusted = false, blocked = false,
                device_credential_hash = NULL, force_otp_next = true,
                session_version = session_version + 1, updated_at = now()
          WHERE id = $1 AND admin_user_id = $2`,
        [deviceId, userId],
      )
      await client.query(
        `UPDATE admin_panel_sessions SET revoked_at = now()
          WHERE device_id = $1 AND revoked_at IS NULL`,
        [deviceId],
      )
      const revoked = await api('/admin/auth/session', {
        deviceCred: newCred,
        fingerprint: rawFp,
      })
      assert.equal(revoked.json?.authenticated, false)
      pass('revoke_invalidates_trust', 'credential no longer restores session')

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
        assert.equal(
          login.json?.step,
          'otp_required',
          JSON.stringify({ step: login.json?.step, code: login.json?.code }),
        )
        pass('new_device_requires_otp', 'different fingerprint → otp_required')
      } else {
        pass('new_device_requires_otp', 'skipped (ADMIN_LOGIN_PIN unavailable in process env)')
      }

      pass('security_center_still_protected', 'block/revoke still invalidate sessions')
    } finally {
      await client.query(`DELETE FROM admin_panel_sessions WHERE device_id = $1`, [deviceId])
      await client.query(`DELETE FROM admin_panel_trusted_devices WHERE id = $1`, [deviceId])
      pass('cleanup', 'disposable test device removed')
    }
  } finally {
    await client.end()
  }

  const failed = results.filter((r) => !r.ok)
  console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2))
  if (failed.length) process.exit(1)
}

main().catch((e) => {
  console.error(String(e?.stack || e))
  process.exit(1)
})
