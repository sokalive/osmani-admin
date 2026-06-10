import { getPool } from '../db/pool.js'

export async function getBeemRow() {
  const pool = getPool()
  const { rows } = await pool.query(`SELECT * FROM beem_settings WHERE id = 1`)
  return rows[0] ?? null
}

export async function updateBeemRowFull(d) {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE beem_settings SET
       enabled = COALESCE($1, enabled),
       api_key = COALESCE($2, api_key),
       secret_key = COALESCE($3, secret_key),
       sender_name = COALESCE($4, sender_name),
       last_test_at = COALESCE($5::timestamptz, last_test_at),
       last_test_ok = COALESCE($6, last_test_ok),
       last_test_message = COALESCE($7, last_test_message),
       updated_at = now()
     WHERE id = 1
     RETURNING *`,
    [
      d.enabled,
      d.api_key,
      d.secret_key,
      d.sender_name,
      d.last_test_at ?? null,
      d.last_test_ok,
      d.last_test_message,
    ],
  )
  return rows[0] ?? null
}

export async function listSmsTemplates() {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT template_key, body, description, enabled, updated_at
     FROM sms_templates
     ORDER BY template_key ASC`,
  )
  return rows
}

export async function getSmsTemplate(key) {
  const pool = getPool()
  const k = String(key ?? '').trim()
  if (!k) return null
  const { rows } = await pool.query(`SELECT * FROM sms_templates WHERE template_key = $1`, [k])
  return rows[0] ?? null
}

export async function upsertSmsTemplate({ templateKey, body, enabled, description }) {
  const pool = getPool()
  const k = String(templateKey ?? '').trim()
  if (!k) throw new Error('template_key is required')
  const { rows } = await pool.query(
    `INSERT INTO sms_templates (template_key, body, description, enabled, updated_at)
     VALUES ($1, $2, $3, COALESCE($4, true), now())
     ON CONFLICT (template_key) DO UPDATE SET
       body = EXCLUDED.body,
       description = COALESCE(EXCLUDED.description, sms_templates.description),
       enabled = COALESCE(EXCLUDED.enabled, sms_templates.enabled),
       updated_at = now()
     RETURNING *`,
    [k, String(body ?? ''), String(description ?? ''), enabled],
  )
  return rows[0] ?? null
}

export async function insertSmsLog({
  recipient,
  deviceId,
  message,
  templateKey,
  triggerType,
  status,
  providerResponse,
  providerMessageId,
  idempotencyKey,
}) {
  const pool = getPool()
  const idem = String(idempotencyKey ?? '').trim()
  if (idem) {
    const { rows: existing } = await pool.query(
      `SELECT id FROM sms_send_log WHERE idempotency_key = $1 LIMIT 1`,
      [idem],
    )
    if (existing[0]) return { row: existing[0], duplicate: true }
  }
  const { rows } = await pool.query(
    `INSERT INTO sms_send_log (
       recipient, device_id, message, template_key, trigger_type, status,
       provider_response, provider_message_id, idempotency_key
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
     RETURNING *`,
    [
      String(recipient ?? ''),
      String(deviceId ?? ''),
      String(message ?? ''),
      String(templateKey ?? ''),
      String(triggerType ?? ''),
      String(status ?? 'pending'),
      providerResponse != null ? JSON.stringify(providerResponse) : null,
      String(providerMessageId ?? ''),
      idem,
    ],
  )
  return { row: rows[0], duplicate: false }
}

export async function listSmsLog({ limit = 100, offset = 0 } = {}) {
  const pool = getPool()
  const lim = Math.min(500, Math.max(1, Number(limit) || 100))
  const off = Math.max(0, Number(offset) || 0)
  const { rows } = await pool.query(
    `SELECT id, recipient, device_id, message, template_key, trigger_type, status,
            provider_response, provider_message_id, created_at
     FROM sms_send_log
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [lim, off],
  )
  const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS total FROM sms_send_log`)
  return { rows, total: countRows[0]?.total ?? 0 }
}
