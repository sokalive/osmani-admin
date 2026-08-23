import { getPool } from '../db/pool.js'
import { ensureSecurityVerificationSchema } from '../db/securityVerificationSchema.js'
import { liveSyncBus } from './liveSyncBus.js'

function text(v, max = 256) {
  return String(v ?? '')
    .trim()
    .slice(0, max)
}

export async function recordSecurityAnomaly({
  deviceId = '',
  anomalyType,
  severity = 'warning',
  detail = '',
  ip = '',
  metadata = {},
}) {
  const pool = getPool()
  if (!pool) return null
  await ensureSecurityVerificationSchema(pool)

  const d = text(deviceId, 128)
  const type = text(anomalyType, 64)
  if (!type) return null

  const { rows } = await pool.query(
    `INSERT INTO security_anomalies (device_id, anomaly_type, severity, detail, ip, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())
     RETURNING id, created_at`,
    [d, type, text(severity, 32), text(detail, 2000), text(ip, 64), metadata || {}],
  )

  if (d) {
    await pool
      .query(
        `UPDATE device_security_profiles
       SET anomaly_count = anomaly_count + 1,
           replay_attempt_count = replay_attempt_count + CASE WHEN $2 = 'nonce_replay' THEN 1 ELSE 0 END,
           updated_at = now()
       WHERE device_id = $1`,
        [d, type],
      )
      .catch(() => {})
  }

  liveSyncBus.publish('security_anomaly', {
    topics: ['config'],
    device_id: d,
    anomaly_type: type,
    severity,
    synced_at: new Date().toISOString(),
  })

  return rows[0]
}

export async function appendSevereHistory({
  deviceId,
  riskType,
  riskScore,
  signals,
  flags,
  source = 'report',
  challengeNonce = '',
  metadata = {},
}) {
  const pool = getPool()
  if (!pool) return null
  await ensureSecurityVerificationSchema(pool)

  const d = text(deviceId, 128)
  if (!d) return null

  const { rows } = await pool.query(
    `INSERT INTO security_severe_history (
       device_id, risk_type, risk_score, signals, flags, source, challenge_nonce, metadata, created_at
     ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8::jsonb, now())
     RETURNING id, created_at`,
    [
      d,
      text(riskType, 64),
      Number(riskScore) || 0,
      JSON.stringify(Array.isArray(signals) ? signals : []),
      JSON.stringify(flags && typeof flags === 'object' ? flags : {}),
      text(source, 64),
      text(challengeNonce, 128),
      metadata || {},
    ],
  )

  return rows[0]
}

export async function listDeviceAnomalies(deviceId, limit = 50) {
  const pool = getPool()
  if (!pool) return []
  await ensureSecurityVerificationSchema(pool)
  const d = text(deviceId, 128)
  const lim = Math.min(200, Math.max(1, Number(limit) || 50))
  const { rows } = await pool.query(
    `SELECT id, anomaly_type, severity, detail, ip, metadata, created_at
     FROM security_anomalies
     WHERE device_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [d, lim],
  )
  return rows.map((r) => ({
    id: String(r.id),
    anomaly_type: String(r.anomaly_type),
    severity: String(r.severity),
    detail: String(r.detail || ''),
    ip: String(r.ip || ''),
    metadata: r.metadata && typeof r.metadata === 'object' ? r.metadata : {},
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }))
}

export async function countDeviceAnomalies(deviceId) {
  const pool = getPool()
  if (!pool) return 0
  await ensureSecurityVerificationSchema(pool)
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM security_anomalies WHERE device_id = $1`,
    [text(deviceId, 128)],
  )
  return Number(rows[0]?.n) || 0
}

export async function logSecurityAnomalyEvent(pool, anomaly) {
  if (!pool || !anomaly) return
  await pool
    .query(
      `INSERT INTO security_events (actor, event_type, status, detail, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, now())`,
      [
        text(anomaly.deviceId || 'system', 120),
        'Security anomaly',
        anomaly.severity === 'critical' ? 'blocked' : 'warning',
        text(anomaly.detail, 2000),
        {
          kind: 'security_anomaly',
          anomaly_type: anomaly.anomalyType,
          device_id: anomaly.deviceId || '',
          ...(anomaly.metadata || {}),
        },
      ],
    )
    .catch((e) => console.error('[security-anomaly] log event failed:', e))
}
