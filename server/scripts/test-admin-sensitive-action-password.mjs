/**
 * Shared admin sensitive-action password (3030 default) + Admin Security PIN
 * (ADMIN_SECURITY_PIN env, or DEV fallback 1975 when ADMIN_SECURITY_PIN_DEV_FALLBACK=1).
 */
import assert from 'node:assert/strict'
import {
  getAdminSensitiveActionPassword,
  verifyAdminSensitiveActionPassword,
} from '../src/lib/adminSensitiveActionPassword.js'
import { verifyAdminSecurityPin } from '../src/lib/adminSecurityPin.js'

delete process.env.ADMIN_SENSITIVE_ACTION_PASSWORD
delete process.env.ADMIN_SECURITY_PIN
process.env.ADMIN_SECURITY_PIN_DEV_FALLBACK = '1'

assert.equal(getAdminSensitiveActionPassword(), '3030')
assert.equal(verifyAdminSensitiveActionPassword('3030'), true)
assert.equal(verifyAdminSensitiveActionPassword('5839'), false)
assert.equal(verifyAdminSensitiveActionPassword('wrong'), false)
assert.equal(verifyAdminSecurityPin('1975'), true)
assert.equal(verifyAdminSecurityPin('3030'), false)
assert.equal(verifyAdminSecurityPin('5839'), false)

process.env.ADMIN_SENSITIVE_ACTION_PASSWORD = 'custom'
assert.equal(verifyAdminSensitiveActionPassword('custom'), true)
assert.equal(verifyAdminSensitiveActionPassword('3030'), false)
delete process.env.ADMIN_SENSITIVE_ACTION_PASSWORD

process.env.ADMIN_SECURITY_PIN = '5821'
assert.equal(verifyAdminSecurityPin('5821'), true)
assert.equal(verifyAdminSecurityPin('1975'), false)
delete process.env.ADMIN_SECURITY_PIN
delete process.env.ADMIN_SECURITY_PIN_DEV_FALLBACK

console.log('test-admin-sensitive-action-password: OK')
