import crypto from 'node:crypto'
import { getPool } from '../db/pool.js'
import { loadTrialWatchSettings, normalizeTrialWatchSettings } from './trialWatchSettings.js'

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('Database not configured')
  return pool
}

export function hashDeviceFingerprint(value) {
  const s = String(value ?? '').trim()
  if (!s) return ''
  return crypto.createHash('sha256').update(s).digest('hex')
}

function toIso(v) {
  if (v == null) return null
  if (v instanceof Date) return v.toISOString()
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

async function getRow(deviceId) {
  const pool = requirePool()
  const d = String(deviceId ?? '').trim()
  if (!d) return null
  const { rows } = await pool.query(`SELECT * FROM device_trial_entitlements WHERE device_id = $1`, [d])
  return rows[0] ?? null
}

/**
 * Server-side trial state for a device (survives app restarts when device_id + fingerprint match).
 */
export async function getDeviceTrialWatchStatus(deviceId, fingerprintRaw = '') {
  const settings = await loadTrialWatchSettings()
  const fpHash = hashDeviceFingerprint(fingerprintRaw)
  const row = await getRow(deviceId)
  return buildTrialStatus(settings, row, fpHash)
}

function buildTrialStatus(settings, row, fpHash) {
  const n = normalizeTrialWatchSettings(settings)
  const trialLimitSec = n.enabled ? n.trialMinutes * 60 : 0
  const previewLimitSec = n.enabled && n.previewAfterEnabled ? n.previewSeconds : 0
  const trialConsumed = Math.max(0, Number(row?.trial_seconds_consumed) || 0)
  const previewConsumed = Math.max(0, Number(row?.preview_seconds_consumed) || 0)
  const trialStartedAt = toIso(row?.trial_started_at)
  const trialEndedAt = toIso(row?.trial_ended_at)
  const previewStartedAt = toIso(row?.preview_after_started_at)

  const fingerprintMismatch =
    Boolean(fpHash) &&
    Boolean(row?.fingerprint_hash) &&
    String(row.fingerprint_hash) !== fpHash

  let trialRemainingSec = 0
  let previewRemainingSec = 0
  let phase = 'disabled'
  let playbackAllowed = false
  let playbackGateReason = 'trial_disabled'

  if (!n.enabled) {
    return statusPayload({
      settings: n,
      row,
      phase,
      playbackAllowed,
      playbackGateReason,
      trialRemainingSec,
      previewRemainingSec,
      trialStartedAt,
      trialEndedAt,
      previewStartedAt,
      fingerprintMismatch,
    })
  }

  if (fingerprintMismatch) {
    return statusPayload({
      settings: n,
      row,
      phase: 'blocked',
      playbackAllowed: false,
      playbackGateReason: 'trial_fingerprint_mismatch',
      trialRemainingSec: 0,
      previewRemainingSec: 0,
      trialStartedAt,
      trialEndedAt,
      previewStartedAt,
      fingerprintMismatch: true,
    })
  }

  if (!trialStartedAt) {
    return statusPayload({
      settings: n,
      row,
      phase: 'not_started',
      playbackAllowed: false,
      playbackGateReason: 'trial_not_started',
      trialRemainingSec: trialLimitSec,
      previewRemainingSec: previewLimitSec,
      trialStartedAt,
      trialEndedAt,
      previewStartedAt,
      fingerprintMismatch,
    })
  }

  trialRemainingSec = Math.max(0, trialLimitSec - trialConsumed)
  previewRemainingSec = Math.max(0, previewLimitSec - previewConsumed)

  if (trialRemainingSec > 0) {
    phase = 'trial_active'
    playbackAllowed = true
    playbackGateReason = 'trial_watch_active'
  } else if (previewLimitSec > 0 && previewRemainingSec > 0) {
    phase = 'preview_after_trial'
    playbackAllowed = true
    playbackGateReason = 'trial_preview_active'
  } else {
    phase = 'exhausted'
    playbackAllowed = false
    playbackGateReason = 'trial_exhausted'
  }

  return statusPayload({
    settings: n,
    row,
    phase,
    playbackAllowed,
    playbackGateReason,
    trialRemainingSec,
    previewRemainingSec,
    trialStartedAt,
    trialEndedAt,
    previewStartedAt,
    fingerprintMismatch,
  })
}

function statusPayload(fields) {
  const n = fields.settings
  return {
    enabled: n.enabled,
    trial_watch_enabled: n.enabled,
    trialWatchEnabled: n.enabled,
    trial_watch_minutes: n.trialMinutes,
    trialWatchMinutes: n.trialMinutes,
    trial_preview_seconds: n.previewSeconds,
    trialPreviewSeconds: n.previewSeconds,
    trial_preview_after_enabled: n.previewAfterEnabled,
    trialPreviewAfterEnabled: n.previewAfterEnabled,
    phase: fields.phase,
    playback_allowed: fields.playbackAllowed,
    playbackAllowed: fields.playbackAllowed,
    playback_gate_reason: fields.playbackGateReason,
    playbackGateReason: fields.playbackGateReason,
    trial_remaining_seconds: fields.trialRemainingSec,
    trialRemainingSeconds: fields.trialRemainingSec,
    preview_remaining_seconds: fields.previewRemainingSec,
    previewRemainingSeconds: fields.previewRemainingSec,
    trial_started_at: fields.trialStartedAt,
    trialStartedAt: fields.trialStartedAt,
    trial_ended_at: fields.trialEndedAt,
    trialEndedAt: fields.trialEndedAt,
    preview_after_started_at: fields.previewStartedAt,
    previewAfterStartedAt: fields.previewStartedAt,
    fingerprint_mismatch: fields.fingerprintMismatch === true,
    fingerprintMismatch: fields.fingerprintMismatch === true,
    server_time_ms: Date.now(),
  }
}

/**
 * Start trial once per fingerprint (binds device + fingerprint server-side).
 */
export async function startDeviceTrialWatch(deviceId, fingerprintRaw = '', installInstanceId = '') {
  const pool = requirePool()
  const settings = await loadTrialWatchSettings()
  if (!settings.enabled) {
    return { ok: false, error: 'Trial watch is disabled' }
  }
  const d = String(deviceId ?? '').trim()
  const fpHash = hashDeviceFingerprint(fingerprintRaw)
  if (!d || !fpHash) {
    return { ok: false, error: 'device_id and fingerprint are required' }
  }
  const installId = String(installInstanceId ?? '').trim().slice(0, 128)

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const fpUsed = await client.query(
      `SELECT device_id FROM device_trial_entitlements
       WHERE fingerprint_hash = $1 AND trial_started_at IS NOT NULL
       FOR UPDATE`,
      [fpHash],
    )
    if (fpUsed.rows[0] && String(fpUsed.rows[0].device_id) !== d) {
      await client.query('ROLLBACK')
      return { ok: false, error: 'Trial already used on another device profile' }
    }

    await client.query(
      `INSERT INTO device_trial_entitlements (
         device_id, fingerprint_hash, install_instance_id, trial_started_at, updated_at
       )
       VALUES ($1, $2, $3, now(), now())
       ON CONFLICT (device_id) DO UPDATE SET
         fingerprint_hash = CASE
           WHEN device_trial_entitlements.trial_started_at IS NULL THEN EXCLUDED.fingerprint_hash
           ELSE device_trial_entitlements.fingerprint_hash
         END,
         install_instance_id = CASE
           WHEN device_trial_entitlements.trial_started_at IS NULL THEN EXCLUDED.install_instance_id
           ELSE device_trial_entitlements.install_instance_id
         END,
         trial_started_at = COALESCE(device_trial_entitlements.trial_started_at, now()),
         updated_at = now()`,
      [d, fpHash, installId],
    )

    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }

  return { ok: true, status: await getDeviceTrialWatchStatus(d, fingerprintRaw) }
}

/**
 * Record watch time (trial minutes or preview seconds). Capped per request to reduce abuse.
 */
export async function recordDeviceTrialWatchHeartbeat(
  deviceId,
  fingerprintRaw = '',
  { trialSeconds = 0, previewSeconds = 0 } = {},
) {
  const pool = requirePool()
  const d = String(deviceId ?? '').trim()
  const fpHash = hashDeviceFingerprint(fingerprintRaw)
  if (!d) return { ok: false, error: 'device_id is required' }

  const trialDelta = Math.min(300, Math.max(0, Math.trunc(Number(trialSeconds) || 0)))
  const previewDelta = Math.min(120, Math.max(0, Math.trunc(Number(previewSeconds) || 0)))

  if (trialDelta === 0 && previewDelta === 0) {
    return { ok: true, status: await getDeviceTrialWatchStatus(d, fingerprintRaw) }
  }

  const statusBefore = await getDeviceTrialWatchStatus(d, fingerprintRaw)
  if (statusBefore.fingerprintMismatch) {
    return { ok: false, error: 'fingerprint mismatch' }
  }
  if (!statusBefore.trialStartedAt) {
    return { ok: false, error: 'trial not started' }
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT * FROM device_trial_entitlements WHERE device_id = $1 FOR UPDATE`,
      [d],
    )
    const row = rows[0]
    if (!row) {
      await client.query('ROLLBACK')
      return { ok: false, error: 'trial not started' }
    }
    if (fpHash && row.fingerprint_hash && String(row.fingerprint_hash) !== fpHash) {
      await client.query('ROLLBACK')
      return { ok: false, error: 'fingerprint mismatch' }
    }

    const settings = await loadTrialWatchSettings()
    const trialLimit = settings.trialMinutes * 60
    const previewLimit = settings.previewAfterEnabled ? settings.previewSeconds : 0
    const curTrial = Math.max(0, Number(row.trial_seconds_consumed) || 0)
    const curPreview = Math.max(0, Number(row.preview_seconds_consumed) || 0)

    let nextTrial = curTrial
    let nextPreview = curPreview
    let trialEndedAt = row.trial_ended_at
    let previewStartedAt = row.preview_after_started_at

    if (trialDelta > 0 && curTrial < trialLimit) {
      nextTrial = Math.min(trialLimit, curTrial + trialDelta)
      if (nextTrial >= trialLimit && !trialEndedAt) {
        trialEndedAt = new Date()
      }
    }
    if (previewDelta > 0 && nextTrial >= trialLimit && previewLimit > 0 && curPreview < previewLimit) {
      if (!previewStartedAt) previewStartedAt = new Date()
      nextPreview = Math.min(previewLimit, curPreview + previewDelta)
    }

    await client.query(
      `UPDATE device_trial_entitlements
       SET trial_seconds_consumed = $2,
           preview_seconds_consumed = $3,
           trial_ended_at = COALESCE(trial_ended_at, $4::timestamptz),
           preview_after_started_at = COALESCE(preview_after_started_at, $5::timestamptz),
           updated_at = now()
       WHERE device_id = $1`,
      [d, nextTrial, nextPreview, trialEndedAt, previewStartedAt],
    )
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }

  return { ok: true, status: await getDeviceTrialWatchStatus(d, fingerprintRaw) }
}
