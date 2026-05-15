/**
 * Analytics install reset — thin wrapper over shared admin OTP challenge store.
 */
import { getPool } from '../db/pool.js'
import {
  OTP_PURPOSE_ANALYTICS_RESET,
  createOtpChallenge,
  ensureAdminOtpChallengeTables,
  getLastCompletedChallengeAt,
  issueOtpForChallenge as issueSharedOtp,
  verifyOtpForChallenge,
} from './adminOtpChallengeStore.js'

export {
  generateOtp6,
  generateChallengeToken,
  adminAlertEmail as analyticsResetAlertEmail,
} from './adminOtpChallengeStore.js'

export function analyticsResetPassword() {
  return String(process.env.ANALYTICS_RESET_PASSWORD ?? '1975').trim()
}

export function analyticsResetCooldownMinutes() {
  return Math.min(24 * 60, Math.max(5, Number(process.env.ANALYTICS_RESET_COOLDOWN_MINUTES) || 60))
}

export { ensureAdminOtpChallengeTables as ensureAnalyticsResetTables }

export async function getLastSuccessfulResetAt() {
  return getLastCompletedChallengeAt(OTP_PURPOSE_ANALYTICS_RESET)
}

export async function assertResetCooldown() {
  const last = await getLastSuccessfulResetAt()
  if (!last || Number.isNaN(last.getTime())) return
  const mins = analyticsResetCooldownMinutes()
  const elapsed = Date.now() - last.getTime()
  if (elapsed < mins * 60 * 1000) {
    const waitMin = Math.ceil((mins * 60 * 1000 - elapsed) / 60_000)
    throw new Error(`Reset cooldown active. Try again in about ${waitMin} minute(s).`)
  }
}

export async function createPasswordVerifiedChallenge(meta) {
  await assertResetCooldown()
  return createOtpChallenge(OTP_PURPOSE_ANALYTICS_RESET, meta)
}

export async function issueOtpForChallenge(token) {
  return issueSharedOtp(token, OTP_PURPOSE_ANALYTICS_RESET)
}

export async function verifyOtpAndExecuteReset(token, otpPlain) {
  const verified = await verifyOtpForChallenge(token, otpPlain, OTP_PURPOSE_ANALYTICS_RESET)
  const counts = await clearInstallAnalyticsData(getPool())
  return { ...verified, ...counts }
}

/** Only install + live session analytics — never billing/security tables. */
export async function clearInstallAnalyticsData(db) {
  const p = db || getPool()
  if (!p) throw new Error('Database not configured')
  const installs = await p.query(`DELETE FROM app_installs`)
  const sessions = await p.query(`DELETE FROM live_sessions`)
  return {
    installsDeleted: Number(installs.rowCount) || 0,
    sessionsDeleted: Number(sessions.rowCount) || 0,
  }
}
