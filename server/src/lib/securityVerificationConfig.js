/** Security verification / trust hardening configuration (env-driven). */

export const TRUST_STATES = [
  'pending_verification',
  'verified',
  'degraded',
  'suspicious',
  'blocked',
]

export const SEVERE_SIGNAL_TYPES = new Set([
  'frida_detected',
  'frida',
  'hook_detected',
  'tampered_apk',
  'tampered',
  'resigned_apk',
  'debugger_attached',
  'debugger',
  'debug_detected',
  'clone_detected',
  'clone',
])

export const KNOWN_SIGNAL_TYPES = new Set([
  'root_detected',
  'rooted',
  'jailbreak_ios',
  'emulator_detected',
  'emulator',
  'clone_detected',
  'clone',
  'debug_detected',
  'debugger_attached',
  'debugger',
  'frida_detected',
  'frida',
  'hook_detected',
  'resigned_apk',
  'tampered_apk',
  'tampered',
  'dev_client',
  'integrity_failure',
  'signature_mismatch',
  'device_fingerprint_mismatch',
  'fingerprint_mismatch',
])

/** legacy | optional | required — optional accepts reports without challenge but marks degraded. */
export function securityVerificationMode() {
  const v = String(process.env.SECURITY_VERIFICATION_MODE ?? 'optional')
    .trim()
    .toLowerCase()
  if (v === 'legacy' || v === 'required') return v
  return 'optional'
}

export function securityChallengeTtlSec() {
  return Math.min(900, Math.max(60, Number(process.env.SECURITY_CHALLENGE_TTL_SEC) || 300))
}

export function securityVerificationFreshSec() {
  return Math.min(7 * 86400, Math.max(300, Number(process.env.SECURITY_VERIFICATION_FRESH_SEC) || 86400))
}

export function securityVerificationGraceSec() {
  return Math.min(86400, Math.max(0, Number(process.env.SECURITY_VERIFICATION_GRACE_SEC) || 3600))
}

export function securityCleanVerificationsRequired() {
  return Math.min(20, Math.max(1, Number(process.env.SECURITY_CLEAN_VERIFICATIONS_REQUIRED) || 3))
}

/** all | ever_severe_only | none — when verification is stale, deny playback for whom */
export function securityStaleVerificationDenyPolicy() {
  const v = String(process.env.SECURITY_STALE_VERIFICATION_DENY ?? 'ever_severe_only')
    .trim()
    .toLowerCase()
  if (v === 'all' || v === 'none') return v
  return 'ever_severe_only'
}

export function securityMaxSignalsPerReport() {
  return Math.min(64, Math.max(1, Number(process.env.SECURITY_MAX_SIGNALS_PER_REPORT) || 32))
}

export function securityMaxReportBodyBytes() {
  return Math.min(65536, Math.max(1024, Number(process.env.SECURITY_MAX_REPORT_BODY_BYTES) || 16384))
}

export function playIntegrityPackageName() {
  return String(
    process.env.PLAY_INTEGRITY_PACKAGE_NAME ||
      process.env.OSMANI_ANDROID_PACKAGE_NAME ||
      'com.burudanitv.app',
  ).trim()
}

export function playIntegrityCredentialsConfigured() {
  return Boolean(
    String(process.env.GOOGLE_PLAY_INTEGRITY_CREDENTIALS_JSON || '').trim() ||
      String(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim(),
  )
}

export function isChallengeRequired() {
  return securityVerificationMode() === 'required'
}

export function challengeRequiredForReport() {
  return securityVerificationMode() !== 'legacy'
}
