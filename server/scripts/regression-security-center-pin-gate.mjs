/**
 * Regression: Security Center PIN gate must work when ADMIN_PANEL_AUTH_REQUIRED=false
 * (Contabo/Render trusted installs use legacy X-Admin-Token, not JWT sessions).
 *
 * Usage: node server/scripts/regression-security-center-pin-gate.mjs
 */
import assert from 'node:assert/strict'
import express from 'express'
import { adminAuthRouter } from '../src/routes/adminAuth.js'

process.env.ADMIN_PANEL_AUTH_REQUIRED = 'false'
process.env.ADMIN_API_TOKEN = 'regression-token'
delete process.env.ADMIN_SECURITY_PIN

const app = express()
app.use(express.json())
app.use('/admin/auth', adminAuthRouter)

async function post(path, { token, pin } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Admin-Token': token } : {}),
    },
    body: JSON.stringify({ security_pin: pin ?? '' }),
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

const server = app.listen(0)
const port = server.address().port

try {
  const missing = await post('/admin/auth/verify-security-pin', {})
  assert.equal(missing.status, 403, 'missing token must be rejected before PIN check')

  const wrongPin = await post('/admin/auth/verify-security-pin', {
    token: 'regression-token',
    pin: '9999',
  })
  assert.equal(wrongPin.status, 403, 'wrong PIN must be rejected')
  assert.equal(wrongPin.body?.error, 'Security PIN si sahihi')

  const emptyPin = await post('/admin/auth/verify-security-pin', {
    token: 'regression-token',
    pin: '',
  })
  assert.equal(emptyPin.status, 400, 'empty PIN must not unlock')
  assert.equal(emptyPin.body?.error, 'security_pin required')

  const ok = await post('/admin/auth/verify-security-pin', {
    token: 'regression-token',
    pin: '3030',
  })
  assert.equal(ok.status, 200, 'correct PIN must unlock')
  assert.equal(ok.body?.ok, true)
  assert.notEqual(
    ok.body?.error,
    'ADMIN_PANEL_AUTH_REQUIRED is not enabled on the server',
    'must not block trusted-install unlock',
  )

  console.log('PASS  regression-security-center-pin-gate')
} finally {
  server.close()
}
