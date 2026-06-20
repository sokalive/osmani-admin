/**
 * Lightweight per-request telemetry: which API host + app versionCode hit key mobile endpoints.
 * Shared Postgres lets VPS and Render both write; audit groups by request_host.
 */
import { getPool } from '../db/pool.js'

const TRACKED_PREFIXES = [
  '/api/channels',
  '/api/subscription/verify',
  '/api/subscription-status',
  '/api/update-check',
  '/api/payments/checkout-providers',
  '/api/settings',
]

/** Known Osmani TV versionName → versionCode (extend as releases ship). */
export const VERSION_NAME_TO_CODE = Object.freeze({
  '1.5.0': 15,
  '1.6.0': 16,
  '1.7.0': 17,
  '1.8.0': 18,
  '1.8.1': 19,
  '1.8.2': 24,
})

export function parseVersionCode(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.trunc(n)
}

export function resolveVersionCodeFromPayload(payload) {
  const p = payload && typeof payload === 'object' ? payload : {}
  const direct = parseVersionCode(
    p.version_code ?? p.versionCode ?? p.build_number ?? p.buildNumber ?? p.app_version_code,
  )
  if (direct > 0) return direct

  const name = String(p.version_name ?? p.versionName ?? p.app_version ?? p.appVersion ?? '')
    .trim()
  if (/^\d+$/.test(name)) return parseVersionCode(name)
  if (VERSION_NAME_TO_CODE[name]) return VERSION_NAME_TO_CODE[name]

  const semver = name.match(/^(\d+\.\d+\.\d+)/)
  if (semver && VERSION_NAME_TO_CODE[semver[1]]) return VERSION_NAME_TO_CODE[semver[1]]
  return 0
}

export function extractVersionCodeFromRequest(req) {
  const q = req?.query && typeof req.query === 'object' ? req.query : {}
  const b = req?.body && typeof req.body === 'object' ? req.body : {}
  return (
    resolveVersionCodeFromPayload(q) ||
    resolveVersionCodeFromPayload(b) ||
    parseVersionCode(req.headers['x-app-version-code'] ?? req.headers['x-app-version'])
  )
}

export function extractDeviceIdFromRequest(req) {
  const q = req?.query && typeof req.query === 'object' ? req.query : {}
  const b = req?.body && typeof req.body === 'object' ? req.body : {}
  return String(q.device_id ?? q.deviceId ?? b.device_id ?? b.deviceId ?? '')
    .trim()
    .slice(0, 128)
}

export function requestHostLabel(req) {
  const host = String(
    req.headers['x-forwarded-host'] || req.get?.('host') || req.headers.host || '',
  )
    .split(',')[0]
    .trim()
    .toLowerCase()
  if (!host) return 'unknown'
  if (host.includes('api.osmanitv.com') || host.includes('144.91.117.90')) return 'vps'
  if (host.includes('onrender.com')) return 'render'
  return host
}

export function normalizeApiPath(req) {
  const base = String(req.baseUrl || '')
  const pathPart = String(req.path || req.url || '').split('?')[0]
  let full = `${base}${pathPart}`.replace(/\/{2,}/g, '/')
  if (!full.startsWith('/api')) {
    full = `/api${full.startsWith('/') ? full : `/${full}`}`
  }
  return full
}

export function isTrackedMobilePath(pathname) {
  const p = String(pathname || '').split('?')[0]
  const normalized = p.startsWith('/api') ? p : `/api${p.startsWith('/') ? p : `/${p}`}`
  return TRACKED_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))
}

export async function ensureClientApiTelemetryTable(poolOrClient) {
  const q = (text, params) => poolOrClient.query(text, params)
  await q(`
    CREATE TABLE IF NOT EXISTS client_api_telemetry (
      id BIGSERIAL PRIMARY KEY,
      request_host TEXT NOT NULL DEFAULT '',
      host_label TEXT NOT NULL DEFAULT 'unknown',
      endpoint TEXT NOT NULL DEFAULT '',
      http_method TEXT NOT NULL DEFAULT 'GET',
      version_code INT NOT NULL DEFAULT 0,
      device_id TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  await q(`
    CREATE INDEX IF NOT EXISTS client_api_telemetry_created_at_idx
    ON client_api_telemetry (created_at DESC);
  `)
  await q(`
    CREATE INDEX IF NOT EXISTS client_api_telemetry_version_host_idx
    ON client_api_telemetry (version_code, host_label, created_at DESC);
  `)
}

export function recordClientApiTelemetry(req) {
  const pool = getPool()
  if (!pool) return
  const path = normalizeApiPath(req)
  if (!isTrackedMobilePath(path)) return

  const versionCode = extractVersionCodeFromRequest(req)
  const deviceId = extractDeviceIdFromRequest(req)
  const requestHost = String(
    req.headers['x-forwarded-host'] || req.get?.('host') || req.headers.host || '',
  )
    .split(',')[0]
    .trim()
    .slice(0, 256)

  void (async () => {
    try {
      await ensureClientApiTelemetryTable(pool)
      await pool.query(
        `INSERT INTO client_api_telemetry
           (request_host, host_label, endpoint, http_method, version_code, device_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          requestHost,
          requestHostLabel(req),
          path.slice(0, 128),
          String(req.method || 'GET').slice(0, 8),
          versionCode,
          deviceId,
        ],
      )
    } catch (e) {
      console.warn('[clientApiTelemetry] insert failed:', e?.message || e)
    }
  })()
}
