import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { deviceSubscriptionBus } from '../lib/deviceSubscriptionBus.js'
import { recordSystemNotificationEvent } from '../lib/runtimeNotifications.js'
import { getDeviceSecurityInvestigationReport } from '../lib/deviceSecurityInvestigation.js'
import { getDeviceSecurityVerificationReport } from '../lib/deviceSecurityVerification.js'
import {
  auditUnblockedPlaybackMismatches,
  reconcileUnblockedPlaybackAccess,
} from '../lib/deviceSecurityPlaybackAudit.js'
import {
  applyBulkDeviceSecurityAction,
  applyDeviceSecurityAction,
  auditAndMigrateLowRiskSmartMonitor,
  ensureDeviceSecurityTables,
  getPlaybackSecurityPolicy,
  getRiskDevice,
  getSecurityStats,
  hasDetectionSignals,
  ingestSecurityReport,
  listRiskDevices,
} from '../lib/deviceSecurityStore.js'
import { requireAdminPanelAccess } from '../middleware/adminPanelAuthGate.js'
import { createSecurityChallenge, consumeSecurityChallenge, securityClientIp } from '../lib/securityChallengeStore.js'
import {
  logSecurityAnomalyEvent,
  recordSecurityAnomaly,
} from '../lib/securityAnomalyStore.js'
import { verifyPlayIntegrityToken } from '../lib/playIntegrityVerifier.js'
import {
  securityChallengeRateLimit,
  securityReportBodySizeLimit,
  securityReportRateLimit,
} from '../lib/securityRateLimit.js'
import {
  challengeRequiredForReport,
  isChallengeRequired,
  securityMaxReportBodyBytes,
  securityVerificationMode,
} from '../lib/securityVerificationConfig.js'

export const deviceSecurityReportsRouter = Router()

function text(v, max = 256) {
  return String(v ?? '')
    .trim()
    .slice(0, max)
}

function adminActor(req) {
  return text(req.adminAuth?.email ?? 'Admin', 120)
}

async function logSecurityEvent(pool, { actor, eventType, status, detail, metadata = {} }) {
  await pool.query(
    `INSERT INTO security_events (actor, event_type, status, detail, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, now())`,
    [text(actor, 120), text(eventType, 120), text(status, 32), text(detail, 2000), metadata || {}],
  )
}

function emitSync(event, payload) {
  liveSyncBus.publish(event, {
    topics: ['config'],
    ...payload,
    synced_at: new Date().toISOString(),
  })
  void recordSystemNotificationEvent(event, payload).catch((err) => {
    console.error('[device-security-reports] notification sync failed:', err)
  })
}

function buildSecurityReportResponse(result, policy) {
  const denied = policy?.deny_playback === true
  const playbackAllowed = !denied
  return {
    ok: true,
    device_id: result.device_id,
    phone_user: result.phone_user || '',
    phone: result.phone_user || '',
    phone_resolved_from: result.phone_resolved_from || null,
    risk_score: result.risk_score,
    server_calculated_score: result.server_calculated_score ?? result.risk_score,
    client_claimed_score: result.client_claimed_score ?? null,
    score_mismatch: result.score_mismatch === true,
    security_level: result.security_level,
    trust_state: result.trust_state || 'pending_verification',
    verification_fresh: result.verification_fresh === true,
    playback_gate_reason: policy?.playback_gate_reason || result.playback_gate_reason || null,
    strict_enforcement: result.strict_enforcement === true,
    security_blocked: denied,
    playbackAllowed,
    playback_allowed: playbackAllowed,
    playbackGateReason: denied ? policy?.playback_gate_reason || 'security_blocked' : null,
    enforcement: denied ? 'block' : 'none',
    limitedPlayback: false,
    limited_playback: false,
    challenge_valid: result.challenge_valid === true,
    ever_severe: result.ever_severe === true,
  }
}

async function handleSecurityChallenge(req, res) {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ ok: false, error: 'Database not configured' })
    await ensureDeviceSecurityTables(pool)

    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const deviceId = text(b.device_id ?? b.deviceId, 128)
    if (!deviceId) return res.status(400).json({ ok: false, error: 'device_id required' })

    const challenge = await createSecurityChallenge(deviceId, {
      install_id: b.install_id ?? b.installId,
      app_version: b.app_version ?? b.appVersion,
      ip: securityClientIp(req),
    })

    res.json({ ok: true, ...challenge })
  } catch (e) {
    console.error('[runtime/security-challenge]', e)
    res.status(400).json({ ok: false, error: String(e.message || e) })
  }
}

async function handleSecurityReport(req, res) {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ ok: false, error: 'Database not configured' })
    await ensureDeviceSecurityTables(pool)

    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const deviceId = text(b.device_id ?? b.deviceId, 128)
    const nonce = text(b.security_nonce ?? b.nonce ?? b.challenge_nonce, 128)
    const installId = text(b.install_id ?? b.installId, 128)
    const ip = securityClientIp(req)

    if (!deviceId) return res.status(400).json({ ok: false, error: 'device_id required' })

    let challengeValid = false
    let challengeMissing = !nonce

    if (nonce) {
      const consumed = await consumeSecurityChallenge({ nonce, deviceId, installId, req })
      if (!consumed.ok) {
        await recordSecurityAnomaly({
          deviceId,
          anomalyType: consumed.reason || 'challenge_failed',
          severity: consumed.reason === 'nonce_replay' ? 'critical' : 'warning',
          detail: `Security challenge rejected: ${consumed.reason}`,
          ip,
          metadata: { nonce: nonce.slice(0, 12) + '…' },
        })
        await logSecurityAnomalyEvent(pool, {
          deviceId,
          anomalyType: consumed.reason || 'challenge_failed',
          severity: consumed.reason === 'nonce_replay' ? 'critical' : 'warning',
          detail: `Challenge rejected: ${consumed.reason}`,
          metadata: { nonce_prefix: nonce.slice(0, 8) },
        })
        emitSync('security_anomaly', { device_id: deviceId, anomaly_type: consumed.reason })
        return res.status(403).json({
          ok: false,
          error: `Security verification failed: ${consumed.reason}`,
          code: consumed.reason,
        })
      }
      challengeValid = true
      challengeMissing = false
    } else if (isChallengeRequired()) {
      await recordSecurityAnomaly({
        deviceId,
        anomalyType: 'missing_nonce',
        severity: 'warning',
        detail: 'Security report missing required challenge nonce',
        ip,
      })
      return res.status(403).json({ ok: false, error: 'security_nonce required', code: 'missing_nonce' })
    }

    let attestationPassed = false
    let attestationFailed = false
    let attestationStatus = 'none'
    let attestationVerdict = {}

    const integrityToken = text(b.integrity_token ?? b.integrityToken ?? b.play_integrity_token, 8192)
    if (integrityToken) {
      const att = await verifyPlayIntegrityToken(integrityToken, { expectedNonce: nonce })
      attestationStatus = att.status || 'failed'
      attestationVerdict = att.verdict || {}
      if (att.ok) {
        attestationPassed = true
        attestationStatus = 'passed'
      } else if (att.configured) {
        attestationFailed = true
        await recordSecurityAnomaly({
          deviceId,
          anomalyType: 'attestation_failed',
          severity: 'warning',
          detail: att.error || att.reasons?.join(', ') || 'Play Integrity verification failed',
          ip,
          metadata: { reasons: att.reasons || [] },
        })
      } else {
        attestationStatus = 'unavailable'
      }
    }

    const result = await ingestSecurityReport(b, {
      challengeValid,
      challengeMissing: challengeMissing && challengeRequiredForReport(),
      attestationPassed,
      attestationFailed,
      attestationStatus,
      attestationVerdict,
      nonce,
      ip,
    })
    const policy = await getPlaybackSecurityPolicy(result.device_id)
    const denied = policy?.deny_playback === true

    const shouldLog =
      result.is_new ||
      result.level_changed ||
      result.detected_now ||
      result.security_level === 'blocked' ||
      result.score_mismatch ||
      result.trust_state === 'suspicious'

    if (shouldLog) {
      await logSecurityEvent(pool, {
        actor: result.device_id,
        eventType: result.is_new ? 'Security detection' : 'Security level changed',
        status: result.security_level === 'blocked' ? 'blocked' : 'warning',
        detail: `device:${result.device_id} phone:${result.phone_user || '—'} score:${result.risk_score} server:${result.server_calculated_score} level:${result.security_level} trust:${result.trust_state}`,
        metadata: {
          kind: 'anti_tamper',
          device_id: result.device_id,
          phone_user: result.phone_user || '',
          risk_score: result.risk_score,
          server_calculated_score: result.server_calculated_score,
          client_claimed_score: result.client_claimed_score,
          score_mismatch: result.score_mismatch,
          security_level: result.security_level,
          trust_state: result.trust_state,
          security_blocked: denied,
          signals: result.signals,
          strict_enforcement: true,
          challenge_valid: result.challenge_valid,
        },
      })
      emitSync('security_detection_new', {
        device_id: result.device_id,
        phone_user: result.phone_user || '',
        risk_score: result.risk_score,
        security_level: result.security_level,
        trust_state: result.trust_state,
        security_blocked: denied,
      })
      emitSync('security_alerts_changed', { device_id: result.device_id })
    }

    emitSync('security_device_changed', { device_id: result.device_id })

    if (denied || hasDetectionSignals({ score: result.risk_score, signals: result.signals })) {
      deviceSubscriptionBus.emit('update', { deviceId: result.device_id })
    }

    res.json(buildSecurityReportResponse(result, policy))
  } catch (e) {
    console.error('[runtime/security-report]', e)
    res.status(400).json({ ok: false, error: String(e.message || e) })
  }
}

/** Issue a short-lived verification challenge (nonce). */
deviceSecurityReportsRouter.post(
  '/runtime/security-challenge',
  securityChallengeRateLimit,
  securityReportBodySizeLimit(4096),
  handleSecurityChallenge,
)
deviceSecurityReportsRouter.post(
  '/security/verification-challenge',
  securityChallengeRateLimit,
  securityReportBodySizeLimit(4096),
  handleSecurityChallenge,
)

/** Runtime client anti-tamper report (no admin auth). */
deviceSecurityReportsRouter.post(
  '/runtime/security-report',
  securityReportRateLimit,
  securityReportBodySizeLimit(securityMaxReportBodyBytes()),
  handleSecurityReport,
)
/** Alias used by OsmaniTvExpo `api/security.js`. */
deviceSecurityReportsRouter.post(
  '/security/device-report',
  securityReportRateLimit,
  securityReportBodySizeLimit(securityMaxReportBodyBytes()),
  handleSecurityReport,
)

deviceSecurityReportsRouter.use('/security', requireAdminPanelAccess)

deviceSecurityReportsRouter.get('/security/stats', async (_req, res) => {
  try {
    const stats = await getSecurityStats()
    res.json({ ok: true, ...stats })
  } catch (e) {
    console.error('[security/stats]', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

/** Audit admin-unblocked devices where playback is still denied (layer breakdown). */
deviceSecurityReportsRouter.get('/security/playback-audit', async (_req, res) => {
  try {
    const audit = await auditUnblockedPlaybackMismatches()
    res.json({ ok: true, audit })
  } catch (e) {
    console.error('[security/playback-audit]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** System-wide repair for all smart_monitor / allowed devices (not per-device manual patch). */
deviceSecurityReportsRouter.post('/security/reconcile-unblocked-playback', async (req, res) => {
  try {
    const out = await reconcileUnblockedPlaybackAccess({ emitUpdates: true })
    emitSync('security_device_changed', { reconcile: true, count: out.devices_scanned })
    res.json({ ok: true, ...out })
  } catch (e) {
    console.error('[security/reconcile-unblocked-playback]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Audit ROOT/EMULATOR-only blocked devices; optional migrate to Smart Monitor. */
deviceSecurityReportsRouter.get('/security/root-emulator-audit', async (_req, res) => {
  try {
    const audit = await auditAndMigrateLowRiskSmartMonitor({ execute: false })
    res.json({ ok: true, audit })
  } catch (e) {
    console.error('[security/root-emulator-audit]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

deviceSecurityReportsRouter.post('/security/migrate-root-emulator-smart-monitor', async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ ok: false, error: 'Database not configured' })
    const actor = adminActor(req)
    const audit = await auditAndMigrateLowRiskSmartMonitor({ execute: true, actor })
    await logSecurityEvent(pool, {
      actor,
      eventType: 'Security root/emulator smart monitor migration',
      status: 'completed',
      detail: `migrated ${audit.counts.migrated} devices; kept blocked ${audit.counts.keep_blocked}`,
      metadata: {
        counts: audit.counts,
        migrated_device_ids: audit.migrated.map((m) => m.device_id),
        failed: audit.failed,
      },
    })
    emitSync('security_device_changed', { migration: 'root_emulator_smart_monitor', ...audit.counts })
    emitSync('security_logs_changed', { action: 'migrate_root_emulator_smart_monitor' })
    res.json({ ok: true, audit })
  } catch (e) {
    console.error('[security/migrate-root-emulator-smart-monitor]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

deviceSecurityReportsRouter.get('/security/devices', async (req, res) => {
  try {
    const devices = await listRiskDevices({
      q: req.query.q,
      level: req.query.level,
      limit: req.query.limit,
    })
    res.json({ ok: true, devices })
  } catch (e) {
    console.error('[security/devices]', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

deviceSecurityReportsRouter.get('/security/devices/:deviceId', async (req, res) => {
  try {
    const device = await getRiskDevice(req.params.deviceId)
    if (!device) return res.status(404).json({ error: 'Device not found' })
    res.json({ ok: true, device })
  } catch (e) {
    console.error('[security/devices/:id]', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

/** Read-only investigation report (on-demand; does not change enforcement). */
deviceSecurityReportsRouter.get('/security/devices/:deviceId/investigation', async (req, res) => {
  try {
    const report = await getDeviceSecurityInvestigationReport(req.params.deviceId)
    if (!report) return res.status(404).json({ ok: false, error: 'Device not found' })
    res.json({ ok: true, report })
  } catch (e) {
    console.error('[security/devices/:id/investigation]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Automated post-unblock verification with Swahili admin summary. */
deviceSecurityReportsRouter.get('/security/devices/:deviceId/verification', async (req, res) => {
  try {
    const verification = await getDeviceSecurityVerificationReport(req.params.deviceId)
    if (!verification) return res.status(404).json({ ok: false, error: 'Device not found' })
    res.json({ ok: true, verification })
  } catch (e) {
    console.error('[security/devices/:id/verification]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

const ACTIONS = new Set([
  'allow_device',
  'whitelist',
  'remove_restriction',
  'temporary_block',
  'permanent_block',
  'reset_risk',
  'force_logout',
  'block_user',
  'unblock_user',
  'enable_smart_monitor',
  'disable_smart_monitor',
])

const AUDIT_EVENT_BY_ACTION = {
  block_user: 'Security block user',
  permanent_block: 'Security block user',
  temporary_block: 'Security block user',
  unblock_user: 'Security unblock user',
  enable_smart_monitor: 'Security smart monitor enable',
  disable_smart_monitor: 'Security smart monitor disable',
}

deviceSecurityReportsRouter.post('/security/devices/:deviceId/action', async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    const deviceId = text(req.params.deviceId, 128)
    const action = text(req.body?.action, 64)
    if (!ACTIONS.has(action)) return res.status(400).json({ error: 'Invalid action' })

    let device = null
    if (action === 'force_logout') {
      deviceSubscriptionBus.emit('update', { deviceId })
      emitSync('security_force_logout', { device_id: deviceId })
      emitSync('subscription_revoked', { device_id: deviceId, reason: 'security_force_logout' })
      await logSecurityEvent(pool, {
        actor: adminActor(req),
        eventType: 'Security force logout',
        status: 'completed',
        detail: `Forced session refresh for ${deviceId}`,
        metadata: { device_id: deviceId, action },
      })
      device = (await getRiskDevice(deviceId)) || { device_id: deviceId }
    } else {
      device = await applyDeviceSecurityAction(deviceId, action, {
        ...(req.body || {}),
        actor: adminActor(req),
      })
      const auditType = AUDIT_EVENT_BY_ACTION[action] || `Security action: ${action}`
      await logSecurityEvent(pool, {
        actor: adminActor(req),
        eventType: auditType,
        status: action.includes('block') && action !== 'unblock_user' ? 'blocked' : 'completed',
        detail: `${action} on ${deviceId}`,
        metadata: {
          device_id: deviceId,
          action,
          smart_monitor_enabled: device?.smart_monitor_enabled === true,
          blocked: device?.blocked === true,
          unblocked_at: device?.unblocked_at ?? null,
          unblocked_by: device?.unblocked_by ?? null,
        },
      })
      deviceSubscriptionBus.emit('update', { deviceId })
    }

    const verification = await getDeviceSecurityVerificationReport(deviceId).catch((e) => {
      console.error('[security/devices/action] verification failed:', e)
      return null
    })

    emitSync('security_admin_action', { device_id: deviceId, action })
    emitSync('security_device_changed', { device_id: deviceId })
    emitSync('security_logs_changed', { action, device_id: deviceId })

    res.json({ ok: true, device, verification })
  } catch (e) {
    console.error('[security/devices/action]', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

deviceSecurityReportsRouter.post('/security/devices/bulk-action', async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const action = text(b.action, 64)
    const deviceIds = Array.isArray(b.device_ids) ? b.device_ids : []
    if (!ACTIONS.has(action) || action === 'force_logout') {
      return res.status(400).json({ error: 'Invalid bulk action' })
    }
    if (deviceIds.length === 0) return res.status(400).json({ error: 'device_ids required' })

    const out = await applyBulkDeviceSecurityAction(deviceIds, action)
    await logSecurityEvent(pool, {
      actor: adminActor(req),
      eventType: `Security bulk: ${action}`,
      status: 'completed',
      detail: `${action} on ${out.updated} devices`,
      metadata: { action, count: out.updated },
    })
    for (const id of deviceIds) {
      deviceSubscriptionBus.emit('update', { deviceId: text(id, 128) })
    }
    emitSync('security_admin_action', { action, count: out.updated })
    emitSync('security_device_changed', { bulk: true })
    emitSync('security_logs_changed', { action: 'bulk', bulk_action: action })
    res.json({ ok: true, ...out })
  } catch (e) {
    console.error('[security/devices/bulk-action]', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})
