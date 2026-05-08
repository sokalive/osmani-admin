/**
 * TEMPORARY live diagnostics for transfer_enabled persistence (Render / DB proof).
 * Remove after root cause is confirmed.
 */
import crypto from 'node:crypto'
import os from 'node:os'
import { Router } from 'express'
import { getPool } from '../db/pool.js'

export const debugTransferDiagnosticsRouter = Router()

const TRANSFER_ENABLED_KEY = 'transfer_enabled'

function databaseUrlFingerprint() {
  const raw = String(process.env.DATABASE_URL || '')
  if (!raw) {
    return { configured: false, sha256: null, length: 0 }
  }
  const sha256 = crypto.createHash('sha256').update(raw, 'utf8').digest('hex')
  return {
    configured: true,
    /** Full hash — compare across services without exposing the secret URL. */
    sha256,
    sha256_short: `${sha256.slice(0, 12)}…${sha256.slice(-8)}`,
    length_chars: raw.length,
  }
}

async function ensureAppSettingsTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
}

/** In production, forced DB writes require TRANSFER_DEBUG_TOKEN + x-transfer-debug-token header. */
function assertDebugWriteAllowed(req, res) {
  if (process.env.NODE_ENV !== 'production') {
    return true
  }
  const expected = String(process.env.TRANSFER_DEBUG_TOKEN ?? '').trim()
  if (!expected) {
    res.status(503).json({
      ok: false,
      error:
        'Production: set env TRANSFER_DEBUG_TOKEN on this service, then send header x-transfer-debug-token with the same value.',
    })
    return false
  }
  const got = String(req.headers['x-transfer-debug-token'] ?? '').trim()
  if (got !== expected) {
    res.status(403).json({ ok: false, error: 'Missing or invalid x-transfer-debug-token' })
    return false
  }
  return true
}

function serviceVersion() {
  return {
    render_git_commit: process.env.RENDER_GIT_COMMIT || null,
    render_service_id: process.env.RENDER_SERVICE_ID || null,
    render_instance: process.env.RENDER_INSTANCE_ID || null,
    github_sha: process.env.GITHUB_SHA || null,
    commit_ref:
      process.env.RENDER_GIT_COMMIT ||
      process.env.GITHUB_SHA ||
      process.env.SOURCE_VERSION ||
      null,
    node: process.version,
  }
}

debugTransferDiagnosticsRouter.get('/transfer-enabled', async (_req, res) => {
  const pool = getPool()
  const base = {
    ok: true,
    pid: process.pid,
    hostname: os.hostname(),
    node_env: process.env.NODE_ENV ?? null,
    database_url_fingerprint: databaseUrlFingerprint(),
    timestamp: new Date().toISOString(),
    version: serviceVersion(),
    transfer_enabled_key: TRANSFER_ENABLED_KEY,
  }

  if (!pool) {
    return res.status(503).json({
      ...base,
      ok: false,
      error: 'Database pool not configured (DATABASE_URL missing)',
      transfer_enabled_row: null,
      transfer_enabled_duplicate_count: null,
    })
  }

  try {
    await ensureAppSettingsTable(pool)
    const dup = await pool.query(
      `SELECT COUNT(*)::int AS n FROM app_settings WHERE key = $1`,
      [TRANSFER_ENABLED_KEY],
    )
    const row = await pool.query(
      `SELECT key, value, updated_at
       FROM app_settings
       WHERE key = $1`,
      [TRANSFER_ENABLED_KEY],
    )
    return res.json({
      ...base,
      transfer_enabled_row: row.rows[0] ?? null,
      transfer_enabled_duplicate_count: Number(dup.rows[0]?.n) || 0,
      compare_with_device_control: {
        note:
          'Compare transfer_enabled_row.value with GET /api/settings/device-control -> transferEnabled (after parseBool).',
      },
      forced_write_post: {
        path: '/api/debug/set-transfer-enabled',
        body: { value: true },
        production_auth:
          process.env.NODE_ENV === 'production'
            ? 'Set env TRANSFER_DEBUG_TOKEN; send header x-transfer-debug-token with the same value.'
            : 'Not required when NODE_ENV is not production.',
      },
    })
  } catch (e) {
    console.error('[debug/transfer-enabled] GET', e)
    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
      ...base,
    })
  }
})

debugTransferDiagnosticsRouter.post('/set-transfer-enabled', async (req, res) => {
  if (!assertDebugWriteAllowed(req, res)) return
  const pool = getPool()
  const b = req.body && typeof req.body === 'object' ? req.body : {}
  const raw = b.value
  const wantTrue =
    raw === true ||
    raw === 1 ||
    String(raw ?? '')
      .trim()
      .toLowerCase() === 'true' ||
    String(raw ?? '').trim() === '1'
  const sqlValue = wantTrue ? 'true' : 'false'

  if (!pool) {
    return res.status(503).json({
      ok: false,
      error: 'Database pool not configured',
      requested_boolean: wantTrue,
      sql_value_intended: sqlValue,
      timestamp: new Date().toISOString(),
    })
  }

  const timestamp = new Date().toISOString()

  try {
    await ensureAppSettingsTable(pool)
    /** Direct upsert (same effect as UPDATE-or-insert for this key). */
    const up = await pool.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value,
         updated_at = now()
       RETURNING key, value, updated_at`,
      [TRANSFER_ENABLED_KEY, sqlValue],
    )

    const verify = await pool.query(
      `SELECT key, value, updated_at
       FROM app_settings
       WHERE key = $1`,
      [TRANSFER_ENABLED_KEY],
    )

    const persisted = String(verify.rows[0]?.value ?? '')
    if (persisted !== sqlValue) {
      return res.status(500).json({
        ok: false,
        error: 'post-write verification mismatch',
        requested_boolean: wantTrue,
        sql_value_intended: sqlValue,
        persisted_value: persisted || null,
        upsert_returning: up.rows[0] ?? null,
        verify_row: verify.rows[0] ?? null,
        row_count: Number(up.rowCount) || 0,
        timestamp,
        pid: process.pid,
        hostname: os.hostname(),
        database_url_fingerprint: databaseUrlFingerprint(),
      })
    }

    return res.json({
      ok: true,
      requested_boolean: wantTrue,
      sql_value_written: sqlValue,
      affected_row_count: Number(up.rowCount) || 0,
      upsert_returning: up.rows[0] ?? null,
      verify_select: verify.rows[0] ?? null,
      persisted_value: persisted,
      timestamp,
      pid: process.pid,
      hostname: os.hostname(),
      database_url_fingerprint: databaseUrlFingerprint(),
      version: serviceVersion(),
    })
  } catch (e) {
    console.error('[debug/set-transfer-enabled] POST', e)
    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
      requested_boolean: wantTrue,
      sql_value_intended: sqlValue,
      timestamp,
    })
  }
})
