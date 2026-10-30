import crypto from 'node:crypto'
import { getPool } from '../db/pool.js'

const SECRET_KEY = /secret|password|pin|token|api[_-]?key|otp|authorization|credential|cookie/i

let ensured = false

export function sanitizeAuditFields(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return []
  const fields = []
  for (const key of Object.keys(body).slice(0, 50)) {
    fields.push(SECRET_KEY.test(key) ? `${key}:changed` : key)
  }
  return fields
}

export function sessionRefFromJti(jti) {
  if (!jti) return null
  return crypto.createHash('sha256').update(String(jti)).digest('hex').slice(0, 16)
}

export async function ensurePrivilegedAuditTable(client = getPool()) {
  if (!client) return false
  await client.query(`
    CREATE TABLE IF NOT EXISTS admin_privileged_audit_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      admin_user_id UUID,
      action TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '',
      changed_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
      ip_address TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      session_ref TEXT,
      result TEXT NOT NULL DEFAULT 'ok',
      correlation_id TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS admin_privileged_audit_log_created_idx
    ON admin_privileged_audit_log (created_at DESC)
  `)
  ensured = true
  return true
}

/**
 * Append-only privileged-action record. Values of secret-looking fields are never stored.
 * Failures are swallowed so a logging outage cannot block the admin action itself.
 */
export async function recordPrivilegedAudit({
  adminUserId = null,
  action,
  target = '',
  fields = [],
  ip = '',
  userAgent = '',
  sessionRef = null,
  result = 'ok',
  correlationId = null,
  metadata = {},
} = {}) {
  const pool = getPool()
  if (!pool || !action) return
  try {
    if (!ensured) await ensurePrivilegedAuditTable(pool)
    const safeFields = Array.isArray(fields) ? fields.map((f) => String(f).slice(0, 80)).slice(0, 50) : []
    const safeMeta = metadata && typeof metadata === 'object' ? metadata : {}
    await pool.query(
      `INSERT INTO admin_privileged_audit_log
        (admin_user_id, action, target, changed_fields, ip_address, user_agent, session_ref, result, correlation_id, metadata)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10::jsonb)`,
      [
        adminUserId || null,
        String(action).slice(0, 200),
        String(target || '').slice(0, 400),
        JSON.stringify(safeFields),
        String(ip || '').slice(0, 80),
        String(userAgent || '').slice(0, 400),
        sessionRef ? String(sessionRef).slice(0, 64) : null,
        String(result || 'ok').slice(0, 32),
        correlationId ? String(correlationId).slice(0, 80) : null,
        JSON.stringify(safeMeta),
      ],
    )
  } catch (e) {
    console.warn('[privileged-audit] write skipped:', e?.message || e)
  }
}

export function schedulePrivilegedAudit(req, res) {
  const method = String(req.method || '').toUpperCase()
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return
  if (res.locals?._privAudit) return
  if (!res.locals) res.locals = {}
  res.locals._privAudit = true
  res.on('finish', () => {
    const ip = String(req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? '')
      .split(',')[0]
      .trim()
    void recordPrivilegedAudit({
      adminUserId: req.adminAuth?.userId || req.adminUserId || null,
      action: `${method} ${req.baseUrl || ''}${req.path || ''}`,
      target: String(req.originalUrl || '').slice(0, 400),
      fields: sanitizeAuditFields(req.body),
      ip,
      userAgent: String(req.headers['user-agent'] ?? ''),
      sessionRef: sessionRefFromJti(req.adminAuth?.jti || req.adminJti),
      result: res.statusCode >= 400 ? 'failed' : 'ok',
      correlationId: req.correlationId || null,
    })
  })
}
