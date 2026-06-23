/**
 * Legacy v16–v23 → v24 migration stats from shared telemetry + device intelligence.
 * Brand-new v24 installs (never seen on legacy) are excluded from "updated" counts.
 */
import { getPool } from '../db/pool.js'
import { ensureDeviceIntelligenceTables } from '../db/deviceIntelligenceTables.js'
import {
  ensureClientApiTelemetryTable,
  parseVersionCode,
  VERSION_NAME_TO_CODE,
} from './clientApiTelemetry.js'
import { APP_UPDATE_NEVER_MIN } from './appUpdateTargeting.js'

const LEGACY_MIN = 16
const LEGACY_MAX = 23

function versionCodeFromAppVersionString(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return 0
  if (/^\d+$/.test(s)) return parseVersionCode(s)
  if (VERSION_NAME_TO_CODE[s]) return VERSION_NAME_TO_CODE[s]
  const semver = s.match(/^(\d+\.\d+\.\d+)/)
  if (semver && VERSION_NAME_TO_CODE[semver[1]]) return VERSION_NAME_TO_CODE[semver[1]]
  return 0
}

function isLegacyCode(code) {
  const n = parseVersionCode(code)
  return n >= LEGACY_MIN && n <= LEGACY_MAX
}

function isV24PlusCode(code) {
  return parseVersionCode(code) >= APP_UPDATE_NEVER_MIN
}

function emptyByVersion() {
  const out = {}
  for (let v = LEGACY_MIN; v <= LEGACY_MAX; v += 1) out[`v${v}`] = 0
  return out
}

function classifyDevice({ sawLegacy, sawV24, maxLegacyCode }) {
  if (sawLegacy && sawV24) {
    return { status: 'updated_to_v24', maxLegacyCode }
  }
  if (sawLegacy && !sawV24) {
    return { status: 'legacy_not_updated', maxLegacyCode }
  }
  if (!sawLegacy && sawV24) {
    return { status: 'brand_new_v24', maxLegacyCode: 0 }
  }
  return { status: 'unknown', maxLegacyCode: 0 }
}

function summarizeMigrationDevices(classifiedDevices) {
  const allDevices = classifiedDevices
  const legacyPopulation = allDevices.filter((d) => d.sawLegacy)
  const updatedToV24 = legacyPopulation.filter((d) => d.status === 'updated_to_v24')
  const legacyNotUpdated = legacyPopulation.filter((d) => d.status === 'legacy_not_updated')
  const brandNewV24 = allDevices.filter((d) => d.status === 'brand_new_v24')
  const migrationPopulation = allDevices.filter((d) => d.sawLegacy || d.sawV24)

  const byLegacyVersion = emptyByVersion()
  for (const d of legacyPopulation) {
    const v = d.maxLegacyCode
    if (v >= LEGACY_MIN && v <= LEGACY_MAX) {
      byLegacyVersion[`v${v}`] = (byLegacyVersion[`v${v}`] || 0) + 1
    }
  }

  const totalUniqueDevices = migrationPopulation.length

  return {
    legacyNotUpdated: legacyNotUpdated.length,
    updatedToV24: updatedToV24.length,
    totalLegacyPopulation: legacyPopulation.length,
    brandNewV24: brandNewV24.length,
    totalUniqueDevices,
    byLegacyVersion,
    migrationPopulation,
  }
}

async function buildMigrationDeviceMap(pool) {
  await ensureClientApiTelemetryTable(pool)
  await ensureDeviceIntelligenceTables(pool)

  const { rows: telemetryRows } = await pool.query(
    `SELECT
       device_id,
       BOOL_OR(version_code BETWEEN $1 AND $2) AS saw_legacy,
       BOOL_OR(version_code >= $3) AS saw_v24,
       MAX(CASE WHEN version_code BETWEEN $1 AND $2 THEN version_code ELSE 0 END)::int AS max_legacy_code
     FROM client_api_telemetry
     WHERE device_id <> ''
     GROUP BY device_id`,
    [LEGACY_MIN, LEGACY_MAX, APP_UPDATE_NEVER_MIN],
  )

  const { rows: historyRows } = await pool.query(
    `SELECT DISTINCT
       h.device_id,
       h.app_version
     FROM device_intelligence_device_history h
     WHERE h.device_id <> ''
       AND h.app_version <> ''`,
  )

  const { rows: registryRows } = await pool.query(
    `SELECT
       device_id,
       device_fingerprint,
       phone_number,
       app_version,
       last_seen_at
     FROM device_intelligence_registry
     WHERE device_id <> ''`,
  )

  const deviceMap = new Map()

  function ensureDevice(deviceId) {
    const id = String(deviceId ?? '').trim()
    if (!id) return null
    if (!deviceMap.has(id)) {
      deviceMap.set(id, {
        deviceId: id,
        sawLegacy: false,
        sawV24: false,
        maxLegacyCode: 0,
        phoneNumber: '',
        fingerprint: '',
        lastSeenAt: null,
      })
    }
    return deviceMap.get(id)
  }

  function absorbVersion(deviceId, versionCode) {
    const d = ensureDevice(deviceId)
    if (!d) return
    const code = parseVersionCode(versionCode)
    if (isLegacyCode(code)) {
      d.sawLegacy = true
      d.maxLegacyCode = Math.max(d.maxLegacyCode, code)
    }
    if (isV24PlusCode(code)) d.sawV24 = true
  }

  for (const row of telemetryRows) {
    const d = ensureDevice(row.device_id)
    if (!d) continue
    if (row.saw_legacy) d.sawLegacy = true
    if (row.saw_v24) d.sawV24 = true
    d.maxLegacyCode = Math.max(d.maxLegacyCode, Number(row.max_legacy_code) || 0)
  }

  for (const row of historyRows) {
    absorbVersion(row.device_id, versionCodeFromAppVersionString(row.app_version))
  }

  for (const row of registryRows) {
    const d = ensureDevice(row.device_id)
    if (!d) continue
    d.phoneNumber = String(row.phone_number ?? '').trim()
    d.fingerprint = String(row.device_fingerprint ?? '').trim()
    d.lastSeenAt = row.last_seen_at
    absorbVersion(row.device_id, versionCodeFromAppVersionString(row.app_version))
  }

  return [...deviceMap.values()].map((d) => {
    const { status, maxLegacyCode } = classifyDevice(d)
    return { ...d, status, maxLegacyCode }
  })
}

/** Shared migration population counts (unique device_id). */
export async function queryMigrationDevicePopulationSummary() {
  const pool = getPool()
  if (!pool) {
    return { ok: false, error: 'Database not configured' }
  }

  const allDevices = await buildMigrationDeviceMap(pool)
  const classified = allDevices.map((d) => ({ ...d, ...classifyDevice(d) }))
  const summary = summarizeMigrationDevices(classified)

  return {
    ok: true,
    summary: {
      legacyNotUpdated: summary.legacyNotUpdated,
      updatedToV24: summary.updatedToV24,
      totalLegacyPopulation: summary.totalLegacyPopulation,
      brandNewV24: summary.brandNewV24,
      totalUniqueDevices: summary.totalUniqueDevices,
      byLegacyVersion: summary.byLegacyVersion,
    },
  }
}

/**
 * @param {{ search?: string, limit?: number, offset?: number }} opts
 */
export async function queryAppVersionMigrationStats(opts = {}) {
  const pool = getPool()
  if (!pool) {
    return { ok: false, error: 'Database not configured' }
  }

  const search = String(opts.search ?? '').trim()
  const limit = Math.min(100, Math.max(1, Number(opts.limit) || 25))
  const offset = Math.max(0, Number(opts.offset) || 0)

  const allDevices = await buildMigrationDeviceMap(pool)
  const classified = allDevices.map((d) => ({ ...d, ...classifyDevice(d) }))
  const summary = summarizeMigrationDevices(classified)

  let filtered = summary.migrationPopulation
  if (search) {
    const q = search.toLowerCase()
    filtered = filtered.filter(
      (d) =>
        d.deviceId.toLowerCase().includes(q) ||
        d.phoneNumber.toLowerCase().includes(q) ||
        d.fingerprint.toLowerCase().includes(q),
    )
  }
  filtered.sort((a, b) => {
    const ta = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0
    const tb = b.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0
    return tb - ta
  })

  const items = filtered.slice(offset, offset + limit).map((d) => ({
    deviceId: d.deviceId,
    phoneNumber: d.phoneNumber || null,
    fingerprint: d.fingerprint || null,
    status: d.status,
    maxLegacyVersion: d.maxLegacyCode > 0 ? d.maxLegacyCode : null,
    lastSeenAt: d.lastSeenAt ? new Date(d.lastSeenAt).toISOString() : null,
  }))

  return {
    ok: true,
    summary: {
      legacyNotUpdated: summary.legacyNotUpdated,
      updatedToV24: summary.updatedToV24,
      totalLegacyPopulation: summary.totalLegacyPopulation,
      brandNewV24: summary.brandNewV24,
      totalUniqueDevices: summary.totalUniqueDevices,
      byLegacyVersion: summary.byLegacyVersion,
    },
    pagination: {
      total: filtered.length,
      limit,
      offset,
    },
    items,
  }
}

/** @internal test helper */
export function classifyDeviceForTest(device) {
  return classifyDevice(device)
}
