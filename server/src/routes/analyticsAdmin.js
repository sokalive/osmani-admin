import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import {
  analyticsResetAlertEmail,
  analyticsResetPassword,
  assertResetCooldown,
  createPasswordVerifiedChallenge,
  issueOtpForChallenge,
  verifyOtpAndExecuteReset,
} from '../lib/analyticsResetStore.js'
import { sendAnalyticsResetOtpEmail } from '../lib/resendOtpMail.js'
import { requireAdminPanelAccess } from '../middleware/adminPanelAuthGate.js'
import { queryUniqueDeviceAuditBreakdown } from '../lib/canonicalUniqueDevices.js'
import {
  computePhysicalDeviceCensus,
  queryPhysicalDeviceCensusSnapshot,
} from '../lib/canonicalPhysicalDeviceCensus.js'

export const analyticsAdminRouter = Router()

analyticsAdminRouter.use(requireAdminPanelAccess)

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? 'unknown')
    .split(',')[0]
    .trim()
}

function adminMeta(req) {
  const auth = req.adminAuth || {}
  const legacy = auth.legacy === true
  return {
    adminUserId: String(auth.userId ?? (legacy ? 'legacy' : '')),
    adminEmail: String(auth.email ?? process.env.ADMIN_ALERT_EMAIL ?? 'admin@panel'),
    ip: clientIp(req),
    userAgent: String(req.headers['user-agent'] ?? '').slice(0, 400),
    deviceLabel: String(req.headers['x-admin-device-fingerprint'] ?? '').slice(0, 64),
  }
}

async function logSecurityAudit(pool, { actor, eventType, status, detail, metadata }) {
  if (!pool) return
  await pool.query(
    `INSERT INTO security_events (actor, event_type, status, detail, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, now())`,
    [
      String(actor ?? 'Admin').slice(0, 120),
      String(eventType ?? 'Analytics reset').slice(0, 120),
      String(status ?? 'completed').slice(0, 32),
      String(detail ?? '').slice(0, 2000),
      metadata && typeof metadata === 'object' ? metadata : {},
    ],
  )
}

function emitAnalyticsRefresh() {
  liveSyncBus.publish('analytics.install_reset', { topics: ['analytics'] })
  liveSyncBus.publish('analytics.reset', { topics: ['analytics'] })
}

analyticsAdminRouter.get('/reset-installs/status', async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ ok: false, error: 'Database not configured' })
    const { getLastSuccessfulResetAt, analyticsResetCooldownMinutes } = await import(
      '../lib/analyticsResetStore.js'
    )
    const last = await getLastSuccessfulResetAt()
    let cooldownActive = false
    let cooldownMinutesRemaining = 0
    if (last && !Number.isNaN(last.getTime())) {
      const mins = analyticsResetCooldownMinutes()
      const elapsed = Date.now() - last.getTime()
      if (elapsed < mins * 60 * 1000) {
        cooldownActive = true
        cooldownMinutesRemaining = Math.ceil((mins * 60 * 1000 - elapsed) / 60_000)
      }
    }
    res.json({
      ok: true,
      alertEmailConfigured: Boolean(analyticsResetAlertEmail()),
      resendConfigured: Boolean(String(process.env.RESEND_API_KEY ?? '').trim()),
      cooldownActive,
      cooldownMinutesRemaining,
      lastResetAt: last ? last.toISOString() : null,
    })
  } catch (e) {
    console.error('[analytics-admin] status', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Step 2: verify destructive-action password, open OTP challenge session. */
analyticsAdminRouter.post('/reset-installs/verify-password', async (req, res) => {
  const pool = getPool()
  try {
    if (!pool) return res.status(503).json({ ok: false, error: 'Database not configured' })
    const password = String(req.body?.password ?? '').trim()
    if (!password) return res.status(400).json({ ok: false, error: 'password required' })
    if (password !== analyticsResetPassword()) {
      const meta = adminMeta(req)
      await logSecurityAudit(pool, {
        actor: meta.adminEmail,
        eventType: 'Analytics reset password denied',
        status: 'failed',
        detail: 'Invalid analytics reset password',
        metadata: { ip: meta.ip, user_agent: meta.userAgent },
      })
      return res.status(403).json({ ok: false, error: 'Invalid password' })
    }

    const challenge = await createPasswordVerifiedChallenge(adminMeta(req))
    await logSecurityAudit(pool, {
      actor: challenge.challengeId ? adminMeta(req).adminEmail : 'Admin',
      eventType: 'Analytics reset password verified',
      status: 'completed',
      detail: 'Password accepted; awaiting OTP',
      metadata: {
        ip: adminMeta(req).ip,
        challenge_id: challenge.challengeId,
      },
    })

    res.json({
      ok: true,
      challengeToken: challenge.challengeToken,
      expiresAt: challenge.expiresAt,
    })
  } catch (e) {
    console.error('[analytics-admin] verify-password', e)
    const status = String(e.message || '').includes('cooldown') ? 429 : 500
    res.status(status).json({ ok: false, error: String(e.message || e) })
  }
})

async function handleSendOtp(req, res, { resend: isResend }) {
  const pool = getPool()
  try {
    if (!pool) return res.status(503).json({ ok: false, error: 'Database not configured' })
    const challengeToken = String(req.body?.challengeToken ?? req.body?.challenge_token ?? '').trim()
    if (!challengeToken) return res.status(400).json({ ok: false, error: 'challengeToken required' })

    const alertTo = analyticsResetAlertEmail()
    if (!alertTo) {
      return res.status(503).json({ ok: false, error: 'ADMIN_ALERT_EMAIL is not configured on the server' })
    }

    const { otp, challengeId, adminEmail } = await issueOtpForChallenge(challengeToken)
    const mailed = await sendAnalyticsResetOtpEmail({ to: alertTo, otp })
    if (!mailed.ok && !mailed.skipped) {
      return res.status(503).json({ ok: false, error: 'Could not send OTP email (check Resend configuration)' })
    }
    if (mailed.skipped) {
      return res.status(503).json({ ok: false, error: 'Resend is not configured (RESEND_API_KEY / RESEND_FROM_EMAIL)' })
    }

    await logSecurityAudit(pool, {
      actor: adminEmail || adminMeta(req).adminEmail,
      eventType: isResend ? 'Analytics reset OTP resent' : 'Analytics reset OTP sent',
      status: 'completed',
      detail: `OTP emailed to ${alertTo}`,
      metadata: {
        challenge_id: challengeId,
        ip: adminMeta(req).ip,
        resend: isResend,
      },
    })

    res.json({
      ok: true,
      message: 'OTP sent to admin alert email',
      expiresInMinutes: 5,
      maskedEmail: alertTo.replace(/^(.{2}).*(@.*)$/, '$1***$2'),
    })
  } catch (e) {
    console.error('[analytics-admin] send-otp', e)
    const status =
      String(e.message || '').includes('wait') || String(e.message || '').includes('limit')
        ? 429
        : 400
    if (pool) {
      await logSecurityAudit(pool, {
        actor: adminMeta(req).adminEmail,
        eventType: 'Analytics reset OTP send failed',
        status: 'failed',
        detail: String(e.message || e),
        metadata: { ip: adminMeta(req).ip, resend: isResend },
      }).catch(() => {})
    }
    res.status(status).json({ ok: false, error: String(e.message || e) })
  }
}

/** Step 3: send OTP to ADMIN_ALERT_EMAIL via Resend. */
analyticsAdminRouter.post('/reset-installs/send-otp', (req, res) => {
  void handleSendOtp(req, res, { resend: false })
})

analyticsAdminRouter.post('/reset-installs/resend-otp', (req, res) => {
  void handleSendOtp(req, res, { resend: true })
})

/** Step 4: verify OTP and execute scoped analytics reset. */
analyticsAdminRouter.post('/reset-installs/execute', async (req, res) => {
  const pool = getPool()
  try {
    if (!pool) return res.status(503).json({ ok: false, error: 'Database not configured' })
    const challengeToken = String(req.body?.challengeToken ?? req.body?.challenge_token ?? '').trim()
    const otp = String(req.body?.otp ?? req.body?.code ?? '').trim()
    if (!challengeToken || !otp) {
      return res.status(400).json({ ok: false, error: 'challengeToken and otp required' })
    }

    await assertResetCooldown()

    const meta = adminMeta(req)
    const result = await verifyOtpAndExecuteReset(challengeToken, otp)

    await logSecurityAudit(pool, {
      actor: meta.adminEmail,
      eventType: 'Analytics install reset executed',
      status: 'completed',
      detail: `Cleared ${result.installsDeleted} installs and ${result.sessionsDeleted} live sessions`,
      metadata: {
        ip: meta.ip,
        user_agent: meta.userAgent,
        device_label: meta.deviceLabel,
        challenge_id: result.challengeId,
        otp_verified: true,
        installs_deleted: result.installsDeleted,
        sessions_deleted: result.sessionsDeleted,
      },
    })

    emitAnalyticsRefresh()

    res.json({
      ok: true,
      installsDeleted: result.installsDeleted,
      sessionsDeleted: result.sessionsDeleted,
    })
  } catch (e) {
    console.error('[analytics-admin] execute', e)
    const msg = String(e.message || e)
    if (pool) {
      await logSecurityAudit(pool, {
        actor: adminMeta(req).adminEmail,
        eventType: 'Analytics reset OTP verification failed',
        status: 'failed',
        detail: msg,
        metadata: {
          ip: adminMeta(req).ip,
          otp_verified: false,
        },
      }).catch(() => {})
    }
    const status = msg.includes('cooldown') ? 429 : msg.includes('OTP') ? 403 : 500
    res.status(status).json({ ok: false, error: msg })
  }
})

/** Read-only physical-device census dry-run / audit (graph reconstruction). */
analyticsAdminRouter.get('/physical-device-census', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private, must-revalidate')
    const dryRun = String(req.query.dryRun ?? req.query.dry_run ?? '0') === '1'
    const force = String(req.query.force ?? '0') === '1'
    const auditFingerprints = String(req.query.audit ?? req.query.auditFingerprints ?? '0') === '1'
    const census = dryRun
      ? await computePhysicalDeviceCensus({ dryRun: true, auditFingerprints })
      : await queryPhysicalDeviceCensusSnapshot({ force })
    if (!census.ok && census.aborted) {
      return res.status(409).json(census)
    }
    res.json(census)
  } catch (e) {
    console.error('[analytics-admin] physical-device-census', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Read-only forensic breakdown for dashboard unique-device metric. */
analyticsAdminRouter.get('/unique-devices-audit', async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private, must-revalidate')
    const audit = await queryUniqueDeviceAuditBreakdown()
    if (!audit.ok) return res.status(503).json({ ok: false, error: 'Database not configured' })
    res.json(audit)
  } catch (e) {
    console.error('[analytics-admin] unique-devices-audit', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})
