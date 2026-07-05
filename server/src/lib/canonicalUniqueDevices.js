/**
 * Canonical OSMANI App unique device count for dashboard analytics.
 * Counts distinct canonical device_id from app_installs + verified App telemetry,
 * excluding synthetic/benchmark/admin probe IDs.
 */
import { getPool } from '../db/pool.js'

const SYNTHETIC_PREFIXES = [
  'cap_',
  'cap67_',
  'verify_recovery_',
  'verify_',
  'pool_audit_',
  'benchmark_',
  'probe_',
  '__probe_',
  'test_',
  'aurax-live-probe',
]

const SYNTHETIC_EXACT = new Set(['unknown', 'unassigned-device', 'admin', 'web'])

function isSyntheticDeviceId(deviceId) {
  const d = String(deviceId ?? '').trim().toLowerCase()
  if (!d || d.length < 8) return true
  if (SYNTHETIC_EXACT.has(d)) return true
  for (const p of SYNTHETIC_PREFIXES) {
    if (d.startsWith(p)) return true
  }
  if (/^0+$/.test(d)) return true
  return false
}

function syntheticSqlExclude(column = 'device_id') {
  const col = column
  const likes = SYNTHETIC_PREFIXES.map((_, i) => `lower(${col}) NOT LIKE $${i + 1}`).join(' AND ')
  return `(${col} <> '' AND length(trim(${col})) >= 8 AND ${likes})`
}

/**
 * @returns {Promise<{ ok: boolean, totalUniqueDevices: number, sources: object, sql: string }>}
 */
export async function queryCanonicalUniqueDeviceCount() {
  const pool = getPool()
  if (!pool) return { ok: false, totalUniqueDevices: 0, sources: {}, sql: '' }

  const likeParams = SYNTHETIC_PREFIXES.map((p) => `${p}%`)
  const excludeClause = syntheticSqlExclude('d.device_id')

  const sql = `
    WITH installs AS (
      SELECT DISTINCT trim(device_id)::text AS device_id
      FROM app_installs
      WHERE trim(device_id) <> ''
    ),
    telemetry AS (
      SELECT DISTINCT trim(device_id)::text AS device_id
      FROM client_api_telemetry
      WHERE trim(device_id) <> ''
        AND version_code >= 16
    ),
    combined AS (
      SELECT device_id FROM installs
      UNION
      SELECT device_id FROM telemetry
    ),
    filtered AS (
      SELECT d.device_id
      FROM combined d
      WHERE ${excludeClause}
    )
    SELECT COUNT(*)::int AS total FROM filtered
  `

  const { rows } = await pool.query(sql, likeParams)
  const totalUniqueDevices = Number(rows[0]?.total) || 0

  const [installOnly, telemetryOnly, overlap] = await Promise.all([
    pool.query(
      `SELECT COUNT(DISTINCT trim(device_id))::int AS c FROM app_installs WHERE trim(device_id) <> ''`,
    ),
    pool.query(
      `SELECT COUNT(DISTINCT trim(device_id))::int AS c FROM client_api_telemetry WHERE trim(device_id) <> '' AND version_code >= 16`,
    ),
    pool.query(
      `SELECT COUNT(*)::int AS c FROM (
         SELECT DISTINCT trim(ai.device_id) AS device_id
         FROM app_installs ai
         INNER JOIN client_api_telemetry t ON t.device_id = ai.device_id
       ) x`,
    ),
  ])

  return {
    ok: true,
    totalUniqueDevices,
    sources: {
      app_installs_distinct: Number(installOnly.rows[0]?.c) || 0,
      telemetry_distinct: Number(telemetryOnly.rows[0]?.c) || 0,
      install_telemetry_overlap: Number(overlap.rows[0]?.c) || 0,
      after_synthetic_filter: totalUniqueDevices,
    },
    sql: sql.replace(/\s+/g, ' ').trim(),
    isSyntheticDeviceId,
  }
}

export async function queryUniqueDeviceAuditBreakdown() {
  const pool = getPool()
  if (!pool) return { ok: false }
  const summary = await queryCanonicalUniqueDeviceCount()
  const migration = await pool.query(
    `SELECT COUNT(DISTINCT device_id)::int AS c FROM client_api_telemetry WHERE device_id <> ''`,
  )
  return {
    ok: true,
    canonical: summary,
    legacy_migration_telemetry_all: Number(migration.rows[0]?.c) || 0,
  }
}
