/**
 * API-level Chrome trusted-device flow verification (mirrors Chrome header/cookie behavior).
 * Does not print PIN/OTP/credentials. Uses env secrets when present.
 *
 * Required env:
 *   ADMIN_E2E_EMAIL, ADMIN_E2E_PIN
 * Optional:
 *   ADMIN_API_BASE (default https://api.osmanitv.com/api)
 *   ADMIN_E2E_OTP  (if login requires OTP and email is unavailable)
 *
 * Chrome UA + stable fingerprint simulate same trusted browser across restarts.
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const API = String(process.env.ADMIN_API_BASE || 'https://api.osmanitv.com/api').replace(/\/$/, '')
const EMAIL = String(process.env.ADMIN_E2E_EMAIL || '').trim().toLowerCase()
const PIN = String(process.env.ADMIN_E2E_PIN || '').trim()
const OTP = String(process.env.ADMIN_E2E_OTP || '').trim()
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function fpFor(label) {
  return `chrome-e2e-${label}-${crypto.createHash('sha256').update(label).digest('hex').slice(0, 24)}`
}

async function api(path, { method = 'GET', body, token, deviceCred, fingerprint, cookie } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': CHROME_UA,
  }
  if (token) headers.Authorization = `Bearer ${token}`
  if (deviceCred) headers['X-Admin-Device-Credential'] = deviceCred
  if (fingerprint) headers['X-Admin-Device-Fingerprint'] = fingerprint
  if (cookie) headers.Cookie = cookie
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
    json = { raw: text }
  }
  return { status: res.status, json, setCookie: res.headers.getSetCookie?.() || [] }
}

async function main() {
  if (!EMAIL || !PIN) {
    console.log('SKIP full Chrome API E2E — set ADMIN_E2E_EMAIL and ADMIN_E2E_PIN')
    record('env', false, 'missing ADMIN_E2E_EMAIL/PIN')
    process.exit(2)
  }

  const status = await api('/admin/auth/status')
  assert.equal(status.json?.panelAuthRequired, true)
  record('status', true, 'panelAuthRequired=true')

  const fp = fpFor(`same-${Date.now()}`)
  const login1 = await api('/admin/auth/login', {
    method: 'POST',
    fingerprint: fp,
    body: {
      email: EMAIL,
      pin: PIN,
      device_fingerprint: fp,
      device_name: 'Chrome E2E Trusted PC',
      browser: CHROME_UA,
    },
  })

  let token = login1.json?.token
  let deviceCred = login1.json?.deviceCredential
  let deviceId = login1.json?.deviceId

  if (login1.json?.step === 'otp_required') {
    if (!OTP) {
      record('new_device_login', true, 'otp_required (expected for new fingerprint)')
      record('otp_verify', false, 'ADMIN_E2E_OTP not provided — cannot complete enrollment in this run')
      console.log(JSON.stringify({ ok: false, results, note: 'Provide OTP from email to finish E2E' }, null, 2))
      process.exit(3)
    }
    const pending = login1.json.pendingToken
    const verify = await api('/admin/auth/verify-otp', {
      method: 'POST',
      fingerprint: fp,
      body: {
        pendingToken: pending,
        code: OTP,
        device_fingerprint: fp,
        device_name: 'Chrome E2E Trusted PC',
        browser: CHROME_UA,
      },
    })
    assert.equal(verify.status, 200, JSON.stringify(verify.json))
    assert.ok(verify.json?.token)
    assert.ok(verify.json?.deviceCredential)
    assert.ok(verify.json?.trustedExpiresAt)
    const exp = new Date(verify.json.trustedExpiresAt).getTime()
    const deltaDays = (exp - Date.now()) / 86400000
    assert.ok(deltaDays > 13.5 && deltaDays < 14.5, `trustedExpiresAt delta days=${deltaDays}`)
    token = verify.json.token
    deviceCred = verify.json.deviceCredential
    deviceId = verify.json.deviceId
    record('new_device_login', true, 'email+pin → otp_required')
    record('otp_verify', true, `deviceId=${String(deviceId).slice(0, 8)}…`)
    record('trusted_device_created', true, `expires≈14d (${verify.json.trustedExpiresAt})`)
  } else if (login1.json?.step === 'authenticated') {
    token = login1.json.token
    deviceId = login1.json.deviceId
    record('new_device_login', true, 'already trusted for fingerprint (authenticated without OTP)')
    record('otp_verify', true, 'skipped — device already trusted')
    record('trusted_device_created', true, `deviceId=${String(deviceId || '').slice(0, 8)}…`)
  } else {
    record('new_device_login', false, JSON.stringify(login1.json))
    process.exit(1)
  }

  // Chrome restart simulation: drop session JWT, keep device credential + same fingerprint
  const restore = await api('/admin/auth/session', {
    deviceCred,
    fingerprint: fp,
  })
  assert.equal(restore.json?.authenticated, true, JSON.stringify(restore.json))
  assert.ok(restore.json?.token)
  token = restore.json.token
  record('chrome_restart_restore', true, 'GET /session restored without email/PIN/OTP')

  const me = await api('/admin/auth/me', { token, fingerprint: fp, deviceCred })
  assert.equal(me.json?.ok, true)
  record('session_restoration', true, 'GET /me ok after restore')

  // New Chrome device must require OTP
  const fp2 = fpFor(`other-${Date.now()}`)
  const login2 = await api('/admin/auth/login', {
    method: 'POST',
    fingerprint: fp2,
    body: {
      email: EMAIL,
      pin: PIN,
      device_fingerprint: fp2,
      device_name: 'Chrome E2E Other PC',
      browser: CHROME_UA,
    },
  })
  assert.equal(login2.json?.step, 'otp_required', JSON.stringify(login2.json))
  record('new_device_requires_otp', true, 'different fingerprint → otp_required')

  const failed = results.filter((r) => !r.ok)
  console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2))
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
