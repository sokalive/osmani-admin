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

export { isSyntheticDeviceId, SYNTHETIC_PREFIXES, SYNTHETIC_EXACT }

function syntheticSqlExclude(column = 'device_id') {
  const col = column
  const likes = SYNTHETIC_PREFIXES.map((_, i) => `lower(${col}) NOT LIKE $${i + 1}`).join(' AND ')
  return `(${col} <> '' AND length(trim(${col})) >= 8 AND ${likes})`
}

export { syntheticSqlExclude }

let _canonicalCache = null
let _canonicalCacheAt = 0
const CANONICAL_CACHE_MS = Math.max(
  30_000,
  Math.min(300_000, Number(process.env.CANONICAL_DEVICES_CACHE_MS) || 120_000),
)

/**
 * @returns {Promise<{ ok: boolean, totalUniqueDevices: number, sources: object, sql: string }>}
 */
export async function queryCanonicalUniqueDeviceCount() {
  const now = Date.now()
  if (_canonicalCache && now - _canonicalCacheAt < CANONICAL_CACHE_MS) {
    return { ..._canonicalCache, cached: true, cacheAgeMs: now - _canonicalCacheAt }
  }

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

  const result = {
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
    cached: false,
    cacheAgeMs: 0,
  }
  _canonicalCache = result
  _canonicalCacheAt = Date.now()
  return result
}

export async function queryUniqueDeviceAuditBreakdown() {
  const pool = getPool()
  if (!pool) return { ok: false }
  const summary = await queryCanonicalUniqueDeviceCount()
  const [
    migration,
    registry,
    subscriptions,
    telemetryAll,
    installsAll,
    intelligence,
  ] = await Promise.all([
    pool.query(`SELECT COUNT(DISTINCT device_id)::int AS c FROM client_api_telemetry WHERE device_id <> ''`),
    pool.query(`SELECT COUNT(DISTINCT trim(device_id))::int AS c FROM device_intelligence_registry WHERE trim(device_id) <> ''`),
    pool.query(`SELECT COUNT(DISTINCT device_id)::int AS c FROM device_subscriptions WHERE trim(device_id) <> ''`),
    pool.query(`SELECT COUNT(*)::int AS rows, COUNT(DISTINCT device_id)::int AS distinct_ids FROM client_api_telemetry WHERE device_id <> ''`),
    pool.query(`SELECT COUNT(*)::int AS rows, COUNT(DISTINCT trim(device_id))::int AS distinct_ids FROM app_installs WHERE trim(device_id) <> ''`),
    pool.query(`SELECT COUNT(*)::int AS rows FROM device_intelligence_registry WHERE trim(device_id) <> ''`),
  ])
  const { queryMigrationDevicePopulationSummary } = await import('./appVersionMigration.js')
  const mig = await queryMigrationDevicePopulationSummary().catch(() => ({ ok: false }))
  return {
    ok: true,
    timestampUtc: new Date().toISOString(),
    canonical: summary,
    legacy_migration_metric: mig?.ok ? mig.summary?.totalUniqueDevices : null,
    raw_sources: {
      client_api_telemetry: telemetryAll.rows[0] ?? {},
      app_installs: installsAll.rows[0] ?? {},
      device_intelligence_registry_rows: intelligence.rows[0]?.rows ?? 0,
      device_intelligence_registry_distinct: Number(registry.rows[0]?.c) || 0,
      device_subscriptions_distinct: Number(subscriptions.rows[0]?.c) || 0,
      telemetry_distinct_all_versions: Number(migration.rows[0]?.c) || 0,
    },
    dedupe_key: 'device_id (app_installs UNION client_api_telemetry v16+, minus synthetic prefixes)',
    label: 'Canonical Observed Install Identities',
  }
}
