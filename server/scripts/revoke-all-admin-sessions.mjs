/**
 * Revoke every admin session and trusted-device credential.
 * Does not delete admin users, audit history, or customer data.
 *
 * Usage (only after a fresh Email + PIN + OTP login has been verified):
 *   CONFIRM_ADMIN_SESSION_RESET=YES node server/scripts/revoke-all-admin-sessions.mjs
 */
import '../src/loadEnv.js'
import { getPool } from '../src/db/pool.js'
import { revokeAllAdminSessionsAndDevices } from '../src/adminAuthStore.js'

if (String(process.env.CONFIRM_ADMIN_SESSION_RESET || '') !== 'YES') {
  console.error('Refusing to reset admin sessions. Set CONFIRM_ADMIN_SESSION_RESET=YES')
  process.exit(1)
}

const pool = getPool()
if (!pool) {
  console.error('DATABASE_URL is not configured')
  process.exit(1)
}

const result = await revokeAllAdminSessionsAndDevices()
console.log(
  JSON.stringify({
    ok: true,
    admin_sessions_revoked: result.sessions,
    trusted_devices_invalidated: result.devices,
  }),
)
await pool.end()
