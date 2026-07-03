/**
 * Shared admin sensitive-action password (3030 default).
 */
import assert from 'node:assert/strict'
import {
  getAdminSensitiveActionPassword,
  verifyAdminSensitiveActionPassword,
} from '../src/lib/adminSensitiveActionPassword.js'
import { verifyAdminSecurityPin } from '../src/lib/adminSecurityPin.js'

delete process.env.ADMIN_SENSITIVE_ACTION_PASSWORD

assert.equal(getAdminSensitiveActionPassword(), '3030')
assert.equal(verifyAdminSensitiveActionPassword('3030'), true)
assert.equal(verifyAdminSensitiveActionPassword('5839'), false)
assert.equal(verifyAdminSensitiveActionPassword('wrong'), false)
assert.equal(verifyAdminSecurityPin('3030'), true)
assert.equal(verifyAdminSecurityPin('5839'), false)

process.env.ADMIN_SENSITIVE_ACTION_PASSWORD = 'custom'
assert.equal(verifyAdminSensitiveActionPassword('custom'), true)
assert.equal(verifyAdminSensitiveActionPassword('3030'), false)
delete process.env.ADMIN_SENSITIVE_ACTION_PASSWORD

console.log('test-admin-sensitive-action-password: OK')
