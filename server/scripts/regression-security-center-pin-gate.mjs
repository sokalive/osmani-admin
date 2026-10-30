/**
 * Security Center PIN route must not unlock from X-Admin-Token.
 * Usage: node server/scripts/regression-security-center-pin-gate.mjs
 */
import assert from 'node:assert/strict'
import express from 'express'
import { adminAuthRouter } from '../src/routes/adminAuth.js'

process.env.ADMIN_PANEL_AUTH_REQUIRED = 'false'
process.env.ADMIN_PANEL_LEGACY_TOKEN_FALLBACK = 'true'
process.env.ADMIN_API_TOKEN = 'regression-token'
process.env.ADMIN_TRUSTED_INSTALL = '1'
process.env.LUQMAN_VPS = '1'

const app = express()
app.use(express.json())
app.use('/admin/auth', adminAuthRouter)

const server = app.listen(0)
const port = server.address().port

async function post(path, { token, pin } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Admin-Token': token } : {}),
    },
    body: JSON.stringify({ security_pin: pin ?? '1975' }),
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

try {
  const missing = await post('/admin/auth/verify-security-pin', {})
  assert.equal(missing.status, 401)
  assert.equal(missing.body?.code, 'NO_SESSION')

  const withToken = await post('/admin/auth/verify-security-pin', {
    token: 'regression-token',
    pin: '1975',
  })
  assert.equal(withToken.status, 401)
  assert.equal(withToken.body?.code, 'NO_SESSION')

  const statusRes = await fetch(`http://127.0.0.1:${port}/admin/auth/status`)
  const status = await statusRes.json()
  assert.equal(status.panelAuthRequired, true)
  assert.equal(status.legacyTokenFallback, false)
  assert.equal(status.trustedInstall, false)
  assert.equal(status.permanentTokenGrantsAccess, false)

  console.log('PASS  regression-security-center-pin-gate')
} finally {
  server.close()
}
