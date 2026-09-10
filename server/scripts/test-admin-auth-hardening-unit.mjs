/**
 * Offline unit tests for admin auth hardening (no DB / no network).
 * Usage: node server/scripts/test-admin-auth-hardening-unit.mjs
 */
import assert from 'node:assert/strict'
import { generateAdminDeviceCredential, hashAdminDeviceCredential } from '../src/lib/adminDeviceCredential.js'
import { parseAdminUserAgent, defaultDeviceName } from '../src/lib/adminUaParse.js'
import { verifyConfiguredAdminLoginPin, getConfiguredAdminLoginPin } from '../src/lib/adminLoginPin.js'
import { verifyAdminSecurityPin } from '../src/lib/adminSecurityPin.js'
import { signAdminJwt, verifyAdminJwt } from '../src/lib/adminJwt.js'
import {
  ADMIN_DEVICE_COOKIE,
  ADMIN_SESSION_COOKIE,
  parseCookieHeader,
  readAdminDeviceCredential,
  readAdminSessionToken,
} from '../src/lib/adminAuthCookies.js'

process.env.ADMIN_JWT_SECRET = 'unit-test-admin-jwt-secret-32chars'
process.env.ADMIN_LOGIN_PIN = '3030'
process.env.ADMIN_SECURITY_PIN = '1975'
delete process.env.ADMIN_SECURITY_PIN_DEV_FALLBACK

const cred1 = generateAdminDeviceCredential()
const cred2 = generateAdminDeviceCredential()
assert.notEqual(cred1, cred2)
assert.equal(hashAdminDeviceCredential(cred1).length, 64)
assert.notEqual(hashAdminDeviceCredential(cred1), hashAdminDeviceCredential(cred2))

assert.equal(verifyConfiguredAdminLoginPin('3030'), true)
assert.equal(verifyConfiguredAdminLoginPin('0000'), false)
assert.equal(getConfiguredAdminLoginPin(), '3030')

assert.equal(verifyAdminSecurityPin('1975'), true)
assert.equal(verifyAdminSecurityPin('3030'), false)
assert.equal(verifyAdminSecurityPin(''), false)

const ua = parseAdminUserAgent(
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
)
assert.equal(ua.browser, 'Chrome')
assert.match(ua.osName, /Windows/)
assert.equal(ua.deviceType, 'Desktop')
assert.match(defaultDeviceName(ua), /PC/)

const token = signAdminJwt({ sub: 'u1', em: 'a@b.c', fp: 'fp', jti: 'jti-1' }, { ttlSeconds: 60 })
const payload = verifyAdminJwt(token)
assert.equal(payload.sub, 'u1')
assert.equal(payload.jti, 'jti-1')
assert.equal(verifyAdminJwt('bad.token.here'), null)

const req = {
  headers: {
    cookie: `${ADMIN_SESSION_COOKIE}=sess%2Bvalue; ${ADMIN_DEVICE_COOKIE}=devcred`,
    authorization: '',
  },
}
assert.equal(parseCookieHeader(req)[ADMIN_SESSION_COOKIE], 'sess+value')
assert.equal(readAdminSessionToken(req), 'sess+value')
assert.equal(readAdminDeviceCredential(req), 'devcred')
assert.equal(
  readAdminDeviceCredential({ headers: { 'x-admin-device-credential': 'hdr-cred' } }),
  'hdr-cred',
)
assert.equal(
  readAdminSessionToken({ headers: { authorization: 'Bearer abc.def.ghi' } }),
  'abc.def.ghi',
)

// Fail closed when security PIN unset
delete process.env.ADMIN_SECURITY_PIN
assert.equal(verifyAdminSecurityPin('1975'), false)
assert.equal(verifyAdminSecurityPin(''), false)

console.log('test-admin-auth-hardening-unit: OK')
