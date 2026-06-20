/**
 * VPS migration audit — versionCode × API host matrix from shared Postgres.
 */
import { getPool } from '../db/pool.js'
import { getDatabaseUrlFingerprint } from './deployMeta.js'
import {
  ensureClientApiTelemetryTable,
  parseVersionCode,
  VERSION_NAME_TO_CODE,
} from './clientApiTelemetry.js'

const TARGET_VERSIONS = [15, 16, 17, 18, 19, 20, 21, 22, 23, 24]
const LATEST_OTA_VERSION = 24

function versionCodeFromAppVersionString(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return 0
  if (/^\d+$/.test(s)) return parseVersionCode(s)
  if (VERSION_NAME_TO_CODE[s]) return VERSION_NAME_TO_CODE[s]
  const semver = s.match(/^(\d+\.\d+\.\d+)/)
  if (semver && VERSION_NAME_TO_CODE[semver[1]]) return VERSION_NAME_TO_CODE[semver[1]]
  return 0
}

function classifyMigration(vpsHits, renderHits, unknownHits) {
  const total = vpsHits + renderHits + unknownHits
  if (total === 0) return 'Unknown'
  const vpsPct = vpsHits / total
  const renderPct = renderHits / total
  if (vpsPct >= 0.95) return 'VPS'
  if (renderPct >= 0.95) return 'Render'
  if (vpsHits > 0 && renderHits > 0) return 'Mixed'
  if (unknownHits > 0 && vpsHits === 0 && renderHits === 0) return 'Unknown'
  return vpsHits >= renderHits ? 'VPS' : 'Render'
}

function emptyRow(version) {
  return {
    version,
    vps_requests: 0,
    render_requests: 0,
    unknown_requests: 0,
    vps_devices: 0,
    render_devices: 0,
    registry_devices: 0,
    vps: 'No',
    render: 'No',
    mixed: 'No',
    ota_eligible: version > 0 && version < LATEST_OTA_VERSION ? 'Yes' : version >= LATEST_OTA_VERSION ? 'No' : 'Unknown',
    migration_complete: 'Unknown',
  }
}

export async function runVpsMigrationAudit({ windowDays = 7 } = {}) {
  const pool = getPool()
  if (!pool) {
    return { ok: false, error: 'Database not configured' }
  }

  const days = Math.min(30, Math.max(1, Number(windowDays) || 7))
  await ensureClientApiTelemetryTable(pool)

  const interval = `${days} days`

  const telemetryByVersion = await pool.query(
    `SELECT
       version_code,
       host_label,
       COUNT(*)::int AS hits,
       COUNT(DISTINCT NULLIF(device_id, ''))::int AS devices
     FROM client_api_telemetry
     WHERE created_at > now() - $1::interval
     GROUP BY version_code, host_label
     ORDER BY version_code, host_label`,
    [interval],
  )

  const telemetryEndpoints = await pool.query(
    `SELECT endpoint, host_label, COUNT(*)::int AS hits
     FROM client_api_telemetry
     WHERE created_at > now() - $1::interval
     GROUP BY endpoint, host_label
     ORDER BY hits DESC
     LIMIT 40`,
    [interval],
  )

  const telemetryFirst = await pool.query(
    `SELECT MIN(created_at) AS first_at, MAX(created_at) AS last_at, COUNT(*)::int AS total
     FROM client_api_telemetry`,
  )

  const registryRows = await pool.query(
    `SELECT app_version, COUNT(*)::int AS devices
     FROM device_intelligence_registry
     WHERE last_seen_at > now() - $1::interval
       AND status <> 'blocked'
     GROUP BY app_version
     ORDER BY devices DESC`,
    [interval],
  )

  const securityRows = await pool.query(
    `SELECT app_version, COUNT(*)::int AS devices
     FROM device_security_profiles
     WHERE updated_at > now() - $1::interval
     GROUP BY app_version
     ORDER BY devices DESC`,
    [interval],
  )

  const softUpdate = await pool.query(
    `SELECT key, value FROM app_settings
     WHERE key IN ('update_soft', 'update_force', 'update_version_code', 'update_version_name')`,
  )
  const settings = Object.fromEntries(softUpdate.rows.map((r) => [r.key, r.value]))

  const matrixMap = new Map(TARGET_VERSIONS.map((v) => [v, emptyRow(v)]))

  for (const row of telemetryByVersion.rows) {
    const version = parseVersionCode(row.version_code)
    if (!TARGET_VERSIONS.includes(version)) continue
    const entry = matrixMap.get(version)
    const hits = Number(row.hits) || 0
    const devices = Number(row.devices) || 0
    const label = String(row.host_label || '').toLowerCase()
    if (label === 'vps') {
      entry.vps_requests += hits
      entry.vps_devices += devices
      entry.vps = entry.vps_requests > 0 ? 'Yes' : 'No'
    } else if (label === 'render') {
      entry.render_requests += hits
      entry.render_devices += devices
      entry.render = entry.render_requests > 0 ? 'Yes' : 'No'
    } else {
      entry.unknown_requests += hits
    }
  }

  for (const row of registryRows.rows) {
    const version = versionCodeFromAppVersionString(row.app_version)
    if (!TARGET_VERSIONS.includes(version)) continue
    const entry = matrixMap.get(version)
    entry.registry_devices += Number(row.devices) || 0
  }

  for (const row of securityRows.rows) {
    const version = versionCodeFromAppVersionString(row.app_version)
    if (!TARGET_VERSIONS.includes(version)) continue
    const entry = matrixMap.get(version)
    entry.registry_devices += Number(row.devices) || 0
  }

  const matrix = TARGET_VERSIONS.map((version) => {
    const entry = matrixMap.get(version)
    const hasVps = entry.vps_requests > 0
    const hasRender = entry.render_requests > 0
    entry.mixed = hasVps && hasRender ? 'Yes' : 'No'
    entry.migration_complete = classifyMigration(
      entry.vps_requests,
      entry.render_requests,
      entry.unknown_requests,
    )
    if (entry.vps_requests === 0 && entry.render_requests === 0 && entry.registry_devices > 0) {
      entry.migration_complete = 'Unknown (no host telemetry yet)'
    }
    return entry
  })

  const totalTelemetry = Number(telemetryFirst.rows[0]?.total) || 0
  const vpsTotal = matrix.reduce((s, r) => s + r.vps_requests, 0)
  const renderTotal = matrix.reduce((s, r) => s + r.render_requests, 0)

  return {
    ok: true,
    audit_version: 1,
    window_days: days,
    generated_at: new Date().toISOString(),
    database: getDatabaseUrlFingerprint(),
    update_settings: {
      latest_version_code: parseVersionCode(settings.update_version_code),
      latest_version_name: settings.update_version_name || '',
      soft_update: String(settings.update_soft || '').toLowerCase() === 'true',
      force_update: String(settings.update_force || '').toLowerCase() === 'true',
    },
    telemetry: {
      total_rows_all_time: totalTelemetry,
      first_record_at: telemetryFirst.rows[0]?.first_at || null,
      last_record_at: telemetryFirst.rows[0]?.last_at || null,
      window_vps_requests: vpsTotal,
      window_render_requests: renderTotal,
      endpoints: telemetryEndpoints.rows,
    },
    registry_app_versions: registryRows.rows,
    matrix,
    conclusions: buildConclusions(matrix, totalTelemetry, vpsTotal, renderTotal),
  }
}

function buildConclusions(matrix, totalTelemetry, vpsTotal, renderTotal) {
  const renderDependent = matrix
    .filter((r) => r.render === 'Yes' && r.vps !== 'Yes')
    .map((r) => r.version)
  const renderMixed = matrix.filter((r) => r.mixed === 'Yes').map((r) => r.version)
  const vpsOnly = matrix
    .filter((r) => r.vps === 'Yes' && r.render !== 'Yes')
    .map((r) => r.version)
  const fullyMigrated = matrix
    .filter((r) => r.migration_complete === 'VPS')
    .map((r) => r.version)

  const canShutRenderToday =
    totalTelemetry > 0
      ? renderTotal === 0 && renderDependent.length === 0 && renderMixed.length === 0
      : null

  return {
    can_shut_render_today:
      canShutRenderToday === null
        ? 'UNKNOWN — telemetry just enabled; re-run after 24–48h of traffic'
        : canShutRenderToday
          ? 'YES'
          : 'NO',
    versions_still_on_render_only: renderDependent,
    versions_mixed_vps_render: renderMixed,
    versions_vps_only: vpsOnly,
    versions_fully_migrated: fullyMigrated,
    shared_db_note:
      'VPS and Render both use the same Vultr Postgres (155.138.223.205/osmani_db). Subscription/catalog reads succeed on either host; stream URLs embed the host that served /api/channels.',
    render_stopped_observation:
      'If Render was stopped and users still streamed, they were either hitting VPS (api.osmanitv.com), using cached channel/subscription data briefly, or playback via URLs already pointing at VPS/Bunny — not proof that Render is unused for all versions.',
  }
}
