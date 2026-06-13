/**
 * Verify idempotent device_security_profiles schema migration helpers.
 * Run: node scripts/verify-device-security-schema.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const schemaSrc = readFileSync(path.join(root, 'src/db/deviceSecuritySchema.js'), 'utf8')
const storeSrc = readFileSync(path.join(root, 'src/lib/deviceSecurityStore.js'), 'utf8')
const billingSrc = readFileSync(path.join(root, 'src/db/billingTables.js'), 'utf8')

assert.ok(schemaSrc.includes('migratePromise'), 'in-process migration dedupe')
assert.ok(schemaSrc.includes('currentConstraintDefinition'), 'constraint definition check')
assert.ok(schemaSrc.includes('42710'), 'duplicate_object tolerance')
assert.ok(schemaSrc.includes('DROP CONSTRAINT IF EXISTS'), 'safe drop')
assert.ok(!schemaSrc.includes('ADD CONSTRAINT') || schemaSrc.includes('hasAll'), 'conditional add')
assert.ok(storeSrc.includes('ensureDeviceSecuritySchema'), 'store delegates to shared schema')
assert.ok(!storeSrc.includes('ADD CONSTRAINT device_security_profiles_admin_status_check'), 'no duplicate add in store')
assert.ok(billingSrc.includes('ensureDeviceSecuritySchema'), 'billingTables uses shared schema')
assert.ok(
  !billingSrc.includes('ADD CONSTRAINT device_security_profiles_admin_status_check'),
  'no duplicate add in billingTables',
)

console.log('verify-device-security-schema: OK')
