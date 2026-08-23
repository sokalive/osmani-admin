/**
 * Audit trail for premium playback access decisions (no secrets / payment data).
 */
import { getPool } from '../db/pool.js'

let ensurePromise = null

async function ensureAuditTable(pool) {
  if (ensurePromise) return ensurePromise
  ensurePromise = pool
    .query(
      `CREATE TABLE IF NOT EXISTS premium_playback_access_audit (
         id BIGSERIAL PRIMARY KEY,
         device_id TEXT NOT NULL DEFAULT '',
         channel_id TEXT NOT NULL DEFAULT '',
         decision TEXT NOT NULL,
         reason TEXT NOT NULL DEFAULT '',
         path TEXT NOT NULL DEFAULT '',
         ip TEXT NOT NULL DEFAULT '',
         metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    )
    .then(() =>
      pool.query(
        `CREATE INDEX IF NOT EXISTS premium_playback_access_audit_device_idx
         ON premium_playback_access_audit (device_id, created_at DESC)`,
      ),
    )
    .catch((e) => {
      ensurePromise = null
      throw e
    })
  return ensurePromise
}

function text(v, max = 256) {
  return String(v ?? '')
    .trim()
    .slice(0, max)
}

/**
 * Fire-and-forget audit insert. Never throws to callers.
 */
export function auditPremiumPlaybackAccess({
  deviceId = '',
  channelId = '',
  decision,
  reason = '',
  path = '',
  ip = '',
  metadata = {},
}) {
  const pool = getPool()
  if (!pool) return
  const dec = text(decision, 32)
  if (!dec) return
  void (async () => {
    try {
      await ensureAuditTable(pool)
      await pool.query(
        `INSERT INTO premium_playback_access_audit
           (device_id, channel_id, decision, reason, path, ip, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now())`,
        [
          text(deviceId, 128),
          text(channelId, 64),
          dec,
          text(reason, 120),
          text(path, 120),
          text(ip, 64),
          JSON.stringify(metadata && typeof metadata === 'object' ? metadata : {}),
        ],
      )
    } catch (e) {
      console.error('[premium-playback-audit] insert failed:', e?.message || e)
    }
  })()
}

export async function listPremiumPlaybackAudits(deviceId, limit = 50) {
  const pool = getPool()
  if (!pool) return []
  await ensureAuditTable(pool)
  const lim = Math.min(200, Math.max(1, Number(limit) || 50))
  const { rows } = await pool.query(
    `SELECT id, device_id, channel_id, decision, reason, path, ip, metadata, created_at
     FROM premium_playback_access_audit
     WHERE device_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [text(deviceId, 128), lim],
  )
  return rows.map((r) => ({
    id: String(r.id),
    device_id: String(r.device_id || ''),
    channel_id: String(r.channel_id || ''),
    decision: String(r.decision || ''),
    reason: String(r.reason || ''),
    path: String(r.path || ''),
    ip: String(r.ip || ''),
    metadata: r.metadata && typeof r.metadata === 'object' ? r.metadata : {},
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }))
}
