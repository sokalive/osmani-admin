import { getPool } from '../db/pool.js'

export const TRIAL_SETTING_KEYS = {
  enabled: 'trial_watch_enabled',
  trialMinutes: 'trial_watch_minutes',
  previewSeconds: 'trial_preview_seconds',
  previewAfterEnabled: 'trial_preview_after_enabled',
}

const DEFAULTS = {
  [TRIAL_SETTING_KEYS.enabled]: 'false',
  [TRIAL_SETTING_KEYS.trialMinutes]: '30',
  [TRIAL_SETTING_KEYS.previewSeconds]: '120',
  [TRIAL_SETTING_KEYS.previewAfterEnabled]: 'true',
}

function asBool(v) {
  const s = String(v ?? '')
    .trim()
    .toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

function asInt(v, min, max, fallback) {
  const n = Math.trunc(Number(v))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export function normalizeTrialWatchSettings(raw = {}) {
  const o = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: asBool(o.enabled ?? o.trialWatchEnabled ?? o.trial_watch_enabled),
    trialMinutes: asInt(o.trialMinutes ?? o.trial_watch_minutes, 1, 24 * 60, 30),
    previewSeconds: asInt(o.previewSeconds ?? o.trial_preview_seconds, 0, 24 * 60 * 60, 120),
    previewAfterEnabled: asBool(
      o.previewAfterEnabled ?? o.trial_preview_after_enabled ?? true,
    ),
  }
}

export function trialWatchSettingsToPublicPayload(settings, configVersion = 0) {
  const n = normalizeTrialWatchSettings(settings)
  return {
    ok: true,
    v: Number(configVersion) || 0,
    trial_watch_enabled: n.enabled,
    trialWatchEnabled: n.enabled,
    trial_watch_minutes: n.trialMinutes,
    trialWatchMinutes: n.trialMinutes,
    trial_preview_seconds: n.previewSeconds,
    trialPreviewSeconds: n.previewSeconds,
    trial_preview_after_enabled: n.previewAfterEnabled,
    trialPreviewAfterEnabled: n.previewAfterEnabled,
    server_time_ms: Date.now(),
  }
}

async function ensureTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  for (const [key, value] of Object.entries(DEFAULTS)) {
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
      [key, value],
    )
  }
}

export async function loadTrialWatchSettings() {
  const pool = getPool()
  if (!pool) return normalizeTrialWatchSettings({})
  await ensureTable(pool)
  const keys = Object.values(TRIAL_SETTING_KEYS)
  const { rows } = await pool.query(
    `SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`,
    [keys],
  )
  const byKey = {}
  for (const row of rows) byKey[String(row.key)] = String(row.value ?? '')
  return normalizeTrialWatchSettings({
    enabled: byKey[TRIAL_SETTING_KEYS.enabled],
    trialMinutes: byKey[TRIAL_SETTING_KEYS.trialMinutes],
    previewSeconds: byKey[TRIAL_SETTING_KEYS.previewSeconds],
    previewAfterEnabled: byKey[TRIAL_SETTING_KEYS.previewAfterEnabled],
  })
}

export async function saveTrialWatchSettings(body) {
  const pool = getPool()
  if (!pool) throw new Error('Database not configured')
  const next = normalizeTrialWatchSettings(body)
  await ensureTable(pool)
  const map = {
    [TRIAL_SETTING_KEYS.enabled]: String(next.enabled),
    [TRIAL_SETTING_KEYS.trialMinutes]: String(next.trialMinutes),
    [TRIAL_SETTING_KEYS.previewSeconds]: String(next.previewSeconds),
    [TRIAL_SETTING_KEYS.previewAfterEnabled]: String(next.previewAfterEnabled),
  }
  for (const [key, value] of Object.entries(map)) {
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, value],
    )
  }
  return next
}
