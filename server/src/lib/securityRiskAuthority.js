import { RISK_WEIGHTS } from './deviceSecurityStore.js'
import { KNOWN_SIGNAL_TYPES, SEVERE_SIGNAL_TYPES } from './securityVerificationConfig.js'

function text(v, max = 256) {
  return String(v ?? '')
    .trim()
    .slice(0, max)
}

function normalizeRiskType(raw) {
  const t = text(raw?.risk_type ?? raw?.riskType, 64).toLowerCase()
  if (!t) return { ok: false, error: 'missing risk_type' }
  if (t.length > 64) return { ok: false, error: 'risk_type too long' }
  return { ok: true, risk_type: t }
}

function serverWeightForType(riskType) {
  return RISK_WEIGHTS[riskType] ?? RISK_WEIGHTS[riskType.replace(/_detected$/, '')] ?? 1
}

function markFlag(riskType, flags) {
  const t = String(riskType || '').toLowerCase()
  if (t.includes('root') || t === 'jailbreak_ios') flags.rooted = true
  if (t.includes('emulator')) flags.emulator = true
  if (t.includes('clone')) flags.clone_detected = true
  if (t.includes('debug') || t.includes('debugger')) flags.debugger = true
  if (t.includes('frida') || t.includes('hook')) flags.frida = true
  if (t.includes('resign') || t.includes('tamper')) flags.tampered_apk = true
}

function isSevereType(riskType) {
  const t = String(riskType || '').toLowerCase()
  if (SEVERE_SIGNAL_TYPES.has(t)) return true
  const base = t.replace(/_detected$/, '')
  return SEVERE_SIGNAL_TYPES.has(base) || SEVERE_SIGNAL_TYPES.has(`${base}_detected`)
}

/**
 * Authoritative server-side risk from signals. Client risk_score is NEVER used for enforcement.
 */
export function computeAuthoritativeRiskFromSignals(signals, opts = {}) {
  const maxSignals = opts.maxSignals ?? 32
  const merged = []
  let serverScore = 0
  let clientClaimedScore = 0
  let clientClaimedAny = false
  const seen = new Set()
  const unknown_signals = []
  const flags = {
    rooted: false,
    emulator: false,
    clone_detected: false,
    debugger: false,
    frida: false,
    tampered_apk: false,
  }

  if (!Array.isArray(signals)) {
    return {
      ok: false,
      error: 'signals must be an array',
      score: 0,
      signals: [],
      risk_type: '',
      flags,
      client_claimed_score: 0,
      score_mismatch: false,
      unknown_signals: [],
    }
  }

  if (signals.length > maxSignals) {
    return {
      ok: false,
      error: `too many signals (max ${maxSignals})`,
      score: 0,
      signals: [],
      risk_type: '',
      flags,
      client_claimed_score: 0,
      score_mismatch: false,
      unknown_signals: [],
    }
  }

  for (const raw of signals) {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      return {
        ok: false,
        error: 'invalid signal object',
        score: 0,
        signals: [],
        risk_type: '',
        flags,
        client_claimed_score: 0,
        score_mismatch: false,
        unknown_signals: [],
      }
    }

    const norm = normalizeRiskType(raw)
    if (!norm.ok) {
      return {
        ok: false,
        error: norm.error,
        score: 0,
        signals: [],
        risk_type: '',
        flags,
        client_claimed_score: 0,
        score_mismatch: false,
        unknown_signals: [],
      }
    }

    const risk_type = norm.risk_type
    if (seen.has(risk_type)) continue
    seen.add(risk_type)

    if (!KNOWN_SIGNAL_TYPES.has(risk_type) && !KNOWN_SIGNAL_TYPES.has(risk_type.replace(/_detected$/, ''))) {
      unknown_signals.push(risk_type)
    }

    markFlag(risk_type, flags)
    const weight = serverWeightForType(risk_type)
    serverScore += weight

    if (typeof raw?.risk_score === 'number' && Number.isFinite(raw.risk_score)) {
      clientClaimedAny = true
      clientClaimedScore += Math.max(0, Math.floor(raw.risk_score))
    }

    merged.push({
      risk_type,
      risk_score: weight,
      server_authoritative: true,
      ...(raw?.detail != null ? { detail: text(raw.detail, 500) } : {}),
    })
  }

  const primary =
    merged.find((s) => s.risk_score >= 10)?.risk_type ||
    merged.find((s) => s.risk_score >= 5)?.risk_type ||
    merged[0]?.risk_type ||
    ''

  const score_mismatch =
    clientClaimedAny && (clientClaimedScore !== serverScore || clientClaimedScore < serverScore)

  return {
    ok: true,
    score: serverScore,
    signals: merged,
    risk_type: primary,
    flags,
    client_claimed_score: clientClaimedAny ? clientClaimedScore : null,
    score_mismatch,
    unknown_signals,
    has_severe: merged.some((s) => isSevereType(s.risk_type)),
  }
}

export function extractBodyClientClaimedScore(body) {
  if (body == null || typeof body !== 'object') return null
  if (typeof body.risk_score === 'number' && Number.isFinite(body.risk_score)) {
    return Math.max(0, Math.floor(body.risk_score))
  }
  if (typeof body.client_claimed_score === 'number' && Number.isFinite(body.client_claimed_score)) {
    return Math.max(0, Math.floor(body.client_claimed_score))
  }
  return null
}

export function mergePersistentFlags(prev, reportFlags) {
  return {
    rooted: !!(reportFlags?.rooted || prev?.ever_rooted || prev?.rooted),
    emulator: !!(reportFlags?.emulator || prev?.ever_emulator || prev?.emulator),
    clone_detected: !!(reportFlags?.clone_detected || prev?.ever_clone_detected || prev?.clone_detected),
    debugger: !!(reportFlags?.debugger || prev?.ever_debugger || prev?.debugger),
    frida: !!(reportFlags?.frida || prev?.ever_frida || prev?.frida),
    tampered_apk: !!(reportFlags?.tampered_apk || prev?.ever_tampered_apk || prev?.tampered_apk),
  }
}

export function rowEverSevere(row) {
  if (!row) return false
  if (row.ever_severe === true) return true
  return !!(
    row.ever_frida ||
    row.ever_tampered_apk ||
    row.ever_debugger ||
    row.ever_clone_detected
  )
}

export function isVerificationFresh(row, nowMs = Date.now()) {
  if (!row?.verification_fresh_until) return false
  const t =
    row.verification_fresh_until instanceof Date
      ? row.verification_fresh_until.getTime()
      : new Date(row.verification_fresh_until).getTime()
  return Number.isFinite(t) && t > nowMs
}
