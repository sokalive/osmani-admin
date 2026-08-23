import {
  securityCleanVerificationsRequired,
  securityStaleVerificationDenyPolicy,
  securityVerificationFreshSec,
  securityVerificationGraceSec,
  securityVerificationMode,
} from './securityVerificationConfig.js'
import { isVerificationFresh, mergePersistentFlags, rowEverSevere } from './securityRiskAuthority.js'

/**
 * Resolve trust state and playback trust gate from profile + verification context.
 */
export function resolveTrustContext(profile, ctx = {}) {
  const now = Date.now()
  const mode = securityVerificationMode()
  const freshSec = securityVerificationFreshSec()
  const graceSec = securityVerificationGraceSec()
  const stalePolicy = securityStaleVerificationDenyPolicy()

  const challengeValid = ctx.challengeValid === true
  const challengeMissing = ctx.challengeMissing === true
  const attestationPassed = ctx.attestationPassed === true
  const attestationFailed = ctx.attestationFailed === true
  const scoreMismatch = ctx.scoreMismatch === true
  const cleanAfterSevere = ctx.cleanAfterSevere === true
  const malformed = ctx.malformed === true

  const everSevere = rowEverSevere(profile)
  const fresh = isVerificationFresh(profile, now)

  let trust_state = String(profile?.trust_state || 'pending_verification')
  let verification_fresh_until = profile?.verification_fresh_until
  let last_trusted_verification_at = profile?.last_trusted_verification_at
  let trusted_clean_streak = Number(profile?.trusted_clean_streak) || 0
  let playback_gate_reason = String(profile?.playback_gate_reason || '')

  if (malformed) {
    trust_state = 'suspicious'
    playback_gate_reason = 'malformed_security_report'
  } else if (attestationFailed) {
    trust_state = 'suspicious'
    playback_gate_reason = 'attestation_failed'
  } else if (scoreMismatch || cleanAfterSevere) {
    trust_state = 'suspicious'
    playback_gate_reason = scoreMismatch ? 'client_score_mismatch' : 'clean_after_severe_without_reverification'
  } else if (challengeValid) {
    const freshUntil = new Date(now + freshSec * 1000)
    verification_fresh_until = freshUntil.toISOString()
    last_trusted_verification_at = new Date(now).toISOString()

    const reportClean = ctx.reportScore === 0 && !ctx.reportHasSevere
    if (everSevere && reportClean) {
      trusted_clean_streak += 1
      if (trusted_clean_streak >= securityCleanVerificationsRequired() && attestationPassed) {
        trust_state = 'verified'
        playback_gate_reason = 'reverification_in_progress'
      } else {
        trust_state = 'suspicious'
        playback_gate_reason = 'awaiting_severe_reverification'
      }
    } else if (ctx.reportHasSevere) {
      trusted_clean_streak = 0
      trust_state = 'blocked'
      playback_gate_reason = 'severe_detection'
    } else {
      trusted_clean_streak = reportClean ? trusted_clean_streak + 1 : 0
      trust_state = 'verified'
      playback_gate_reason = ''
    }
  } else if (challengeMissing) {
    if (mode === 'required') {
      trust_state = 'pending_verification'
      playback_gate_reason = 'challenge_required'
    } else {
      trust_state = 'degraded'
      playback_gate_reason = 'legacy_report_no_challenge'
    }
  }

  // Stale verification handling (skip when this report just established fresh verification)
  let verification_stale = false
  if (!challengeValid && !fresh && last_trusted_verification_at) {
    verification_stale = true
    const freshUntilVal = verification_fresh_until ?? profile?.verification_fresh_until
    const freshUntilMs =
      freshUntilVal instanceof Date
        ? freshUntilVal.getTime()
        : freshUntilVal
          ? new Date(freshUntilVal).getTime()
          : NaN
    const graceEnd = freshUntilMs + graceSec * 1000
    const inGrace = Number.isFinite(graceEnd) && graceEnd > now

    if (!inGrace) {
      if (stalePolicy === 'all') {
        trust_state = trust_state === 'blocked' ? 'blocked' : 'degraded'
        playback_gate_reason = playback_gate_reason || 'verification_stale'
      } else if (stalePolicy === 'ever_severe_only' && everSevere) {
        trust_state = 'suspicious'
        playback_gate_reason = playback_gate_reason || 'verification_stale_severe_device'
      }
    }
  } else if (!last_trusted_verification_at && challengeMissing && mode !== 'legacy') {
    verification_stale = true
  }

  const freshAfterUpdate = verification_fresh_until
    ? new Date(verification_fresh_until).getTime() > now
    : fresh

  const deny_for_trust =
    trust_state === 'blocked' ||
    trust_state === 'suspicious' ||
    (trust_state === 'pending_verification' && mode === 'required') ||
    (verification_stale &&
      stalePolicy === 'all' &&
      !freshAfterUpdate &&
      !(verification_fresh_until && graceSec > 0))

  return {
    trust_state,
    verification_fresh_until,
    last_trusted_verification_at,
    trusted_clean_streak,
    playback_gate_reason,
    verification_stale,
    deny_for_trust,
    ever_severe: everSevere,
    effective_flags: mergePersistentFlags(profile, ctx.reportFlags || {}),
  }
}

export function buildEverColumnsUpdate(prev, reportFlags, reportScore, reportHasSevere) {
  const nowIso = new Date().toISOString()
  const ever_frida = !!(prev?.ever_frida || reportFlags?.frida)
  const ever_tampered_apk = !!(prev?.ever_tampered_apk || reportFlags?.tampered_apk)
  const ever_debugger = !!(prev?.ever_debugger || reportFlags?.debugger)
  const ever_clone_detected = !!(prev?.ever_clone_detected || reportFlags?.clone_detected)
  const ever_rooted = !!(prev?.ever_rooted || reportFlags?.rooted)
  const ever_emulator = !!(prev?.ever_emulator || reportFlags?.emulator)
  const ever_severe = ever_frida || ever_tampered_apk || ever_debugger || ever_clone_detected

  const highest = Math.max(Number(prev?.highest_risk_score) || 0, Number(reportScore) || 0)

  let first_severe_at = prev?.first_severe_at || null
  let last_severe_at = prev?.last_severe_at || null
  if (reportHasSevere || reportScore >= 10) {
    if (!first_severe_at) first_severe_at = nowIso
    last_severe_at = nowIso
  }

  return {
    ever_frida,
    ever_tampered_apk,
    ever_debugger,
    ever_clone_detected,
    ever_rooted,
    ever_emulator,
    ever_severe,
    highest_risk_score: highest,
    first_severe_at,
    last_severe_at,
  }
}

export function effectiveEnforcementFlags(profile, reportFlags) {
  return mergePersistentFlags(profile, reportFlags)
}
