/**
 * Offline checks for mandatory admin sessions. No database and no network.
 * Usage: node server/scripts/test-admin-session-enforcement.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import express from 'express'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverRoot = path.join(here, '..')
const repoRoot = path.join(serverRoot, '..')

function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8')
}

function bootEnv(extra) {
  const res = spawnSync(
    process.execPath,
    [
      '-e',
      "import('./src/loadEnv.js').then(() => console.log([process.env.ADMIN_PANEL_AUTH_REQUIRED, process.env.ADMIN_PANEL_LEGACY_TOKEN_FALLBACK, process.env.ADMIN_TRUSTED_INSTALL].join('|')))",
    ],
    {
      cwd: serverRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ADMIN_PANEL_AUTH_REQUIRED: 'false',
        ADMIN_PANEL_LEGACY_TOKEN_FALLBACK: 'true',
        ADMIN_TRUSTED_INSTALL: '1',
        LUQMAN_VPS: '1',
        ...extra,
      },
    },
  )
  if (res.status !== 0) throw new Error(res.stderr || 'loadEnv failed')
  return res.stdout.trim().split('\n').pop()
}

assert.equal(bootEnv({}), 'true|false|0', 'copied flags cannot disable admin auth')
assert.equal(
  bootEnv({ LUQMAN_VPS: '1', ADMIN_TRUSTED_INSTALL: 'true', ADMIN_PANEL_AUTH_REQUIRED: 'false' }),
  'true|false|0',
)

process.env.ADMIN_PANEL_AUTH_REQUIRED = 'false'
process.env.ADMIN_PANEL_LEGACY_TOKEN_FALLBACK = 'true'
process.env.ADMIN_TRUSTED_INSTALL = '1'
process.env.LUQMAN_VPS = '1'
process.env.ADMIN_API_TOKEN = 'legacy-token-value'
process.env.APP_UPDATE_ADMIN_TOKEN = 'legacy-token-value'
process.env.ADMIN_JWT_SECRET = 'unit-test-admin-jwt-secret-32chars'

const { isAdminPanelAuthRequired, requireAdminPanelAccess } = await import(
  '../src/middleware/adminPanelAuthGate.js'
)
const { signAdminJwt } = await import('../src/lib/adminJwt.js')
const { sanitizeAuditFields } = await import('../src/lib/privilegedAuditLog.js')
const { adminOtpDebugHint } = await import('../src/lib/adminOtpDebug.js')
const { verifyAdminSensitiveActionPassword } = await import('../src/lib/adminSensitiveActionPassword.js')

assert.equal(isAdminPanelAuthRequired(), true)

function runGate(headers) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      locals: {},
      status(code) {
        this.statusCode = code
        return this
      },
      json(body) {
        resolve({ status: this.statusCode, body })
      },
      on() {},
    }
    void requireAdminPanelAccess({ headers, method: 'PUT', body: {} }, res, () =>
      resolve({ status: 200, body: { passed: true } }),
    )
  })
}

const missing = await runGate({})
assert.equal(missing.status, 401)
assert.equal(missing.body.code, 'NO_SESSION')

const tokenOnly = await runGate({ 'x-admin-token': 'legacy-token-value' })
assert.equal(tokenOnly.status, 401)
assert.equal(tokenOnly.body.code, 'NO_SESSION')

const expired = signAdminJwt(
  { sub: 'user', em: 'a@b.c', fp: 'fp', jti: 'jti' },
  { ttlSeconds: -10 },
)
const expiredRes = await runGate({ authorization: `Bearer ${expired}` })
assert.equal(expiredRes.status, 401)
assert.equal(expiredRes.body.code, 'INVALID_SESSION')

const pending = signAdminJwt(
  { sub: 'user', em: 'a@b.c', fp: 'fp', typ: 'otp_pending' },
  { ttlSeconds: 60 },
)
const pendingRes = await runGate({ authorization: `Bearer ${pending}` })
assert.equal(pendingRes.status, 401)

delete process.env.ADMIN_SENSITIVE_ACTION_PASSWORD
assert.equal(verifyAdminSensitiveActionPassword('3030'), false)
process.env.ADMIN_SENSITIVE_ACTION_PASSWORD = 'unit-secret'
assert.equal(verifyAdminSensitiveActionPassword('unit-secret'), true)
assert.equal(verifyAdminSensitiveActionPassword('3030'), false)

const leaked = sanitizeAuditFields({
  apiKey: 'super-secret-sonicpesa-key',
  enabled: true,
  freeMode: true,
  password: 'hidden-pass',
})
assert.deepEqual(leaked, ['apiKey:changed', 'enabled', 'freeMode', 'password:changed'])
assert.equal(JSON.stringify(leaked).includes('super-secret-sonicpesa-key'), false)
assert.equal(JSON.stringify(leaked).includes('hidden-pass'), false)

process.env.NODE_ENV = 'production'
process.env.ADMIN_OTP_DEBUG_RETURN = '1'
assert.equal(adminOtpDebugHint('123456'), undefined)
process.env.NODE_ENV = 'test'
assert.equal(adminOtpDebugHint('123456'), '123456')

const apiJs = read('src/lib/api.js')
assert.equal(apiJs.includes('VITE_ADMIN_API_TOKEN'), false)
assert.equal(apiJs.includes('X-Admin-Token'), false)
assert.match(apiJs, /postSubscriptionRevoke = \(body\) =>\s+adminApiRequest\('\/subscription\/revoke'/)

const deviceSecurity = read('server/src/routes/deviceSecurity.js')
assert.match(
  deviceSecurity,
  /deviceSecurityRouter\.post\('\/subscription\/revoke', requireAdminPanelAccess,/,
)

const runtime = read('server/src/routes/runtimePublic.js')
assert.equal(runtime.includes('requireLegacyAdminToken'), false)
assert.equal(runtime.includes('spawnSync'), false)
assert.match(runtime, /runtimePublicRouter\.post\('\/reload-nginx', refuseHostOperation\)/)
assert.match(runtime, /runtimePublicRouter\.post\('\/provision-https', refuseHostOperation\)/)
assert.match(runtime, /requireAdminPanelAccess/)

const gateSrc = read('server/src/middleware/adminPanelAuthGate.js')
assert.equal(gateSrc.includes('legacyTokenMatches'), false)
assert.equal(gateSrc.includes("headers['x-admin-token']"), false)

const authSrc = read('server/src/routes/adminAuth.js')
assert.equal(authSrc.includes('if (req.adminEmergency === true) return next()'), false)
assert.equal(authSrc.includes('session_restore_device_cred'), false)

const cutover = read('server/.env.cutover')
assert.equal(cutover.includes('ADMIN_API_TOKEN'), false)
assert.equal(cutover.includes('APP_UPDATE_ADMIN_TOKEN'), false)

const app = express()
app.put('/api/settings/sonicpesa', requireAdminPanelAccess, (_req, res) => res.json({ ok: true }))
app.put('/api/settings', requireAdminPanelAccess, (_req, res) => res.json({ ok: true }))
const server = app.listen(0)
const port = server.address().port
try {
  for (const pathName of ['/api/settings/sonicpesa', '/api/settings']) {
    const res = await fetch(`http://127.0.0.1:${port}${pathName}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': 'legacy-token-value' },
      body: JSON.stringify({ freeMode: true, apiKey: 'x' }),
    })
    const body = await res.json()
    assert.equal(res.status, 401, pathName)
    assert.equal(body.code, 'NO_SESSION')
  }
} finally {
  server.close()
}

console.log('test-admin-session-enforcement: OK')
