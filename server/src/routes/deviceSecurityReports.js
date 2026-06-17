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
    security_level: result.security_level,
    strict_enforcement: result.strict_enforcement === true,
    security_blocked: denied,
    playbackAllowed,
    playback_allowed: playbackAllowed,
    playbackGateReason: denied ? 'security_blocked' : null,
    playback_gate_reason: denied ? 'security_blocked' : null,
    enforcement: denied ? 'block' : 'none',
    limitedPlayback: false,
    limited_playback: false,
  }
}

async function handleSecurityReport(req, res) {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ ok: false, error: 'Database not configured' })
    await ensureDeviceSecurityTables(pool)

    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const result = await ingestSecurityReport(b)
    const policy = await getPlaybackSecurityPolicy(result.device_id)
    const denied = policy?.deny_playback === true

    const shouldLog =
      result.is_new ||
      result.level_changed ||
      result.detected_now ||
      result.security_level === 'blocked'

    if (shouldLog) {
      await logSecurityEvent(pool, {
        actor: result.device_id,
        eventType: result.is_new ? 'Security detection' : 'Security level changed',
        status: result.security_level === 'blocked' ? 'blocked' : 'warning',
        detail: `strict block device:${result.device_id} phone:${result.phone_user || '—'} score:${result.risk_score} level:${result.security_level}`,
        metadata: {
          kind: 'anti_tamper',
          device_id: result.device_id,
          phone_user: result.phone_user || '',
          risk_score: result.risk_score,
          security_level: result.security_level,
          security_blocked: denied,
          signals: result.signals,
          strict_enforcement: true,
        },
      })
      emitSync('security_detection_new', {
        device_id: result.device_id,
        phone_user: result.phone_user || '',
        risk_score: result.risk_score,
        security_level: result.security_level,
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

/** Runtime client anti-tamper report (no admin auth). */
deviceSecurityReportsRouter.post('/runtime/security-report', handleSecurityReport)
/** Alias used by OsmaniTvExpo `api/security.js`. */
deviceSecurityReportsRouter.post('/security/device-report', handleSecurityReport)

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
