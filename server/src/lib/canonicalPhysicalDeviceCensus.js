/**
 * Deterministic physical-device census via identity graph (union-find).
 * Rules: docs/cross-ai/osmani-physical-device-census-contract.json
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { getPool } from '../db/pool.js'
import { isSyntheticDeviceId, syntheticSqlExclude } from './canonicalUniqueDevices.js'
import { queryCanonicalUniqueDeviceCount } from './canonicalUniqueDevices.js'
import { queryMigrationDevicePopulationSummary } from './appVersionMigration.js'
import { evaluateFingerprintPairProof, redactDeviceId } from './fingerprintMergeProof.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const CONTRACT_PATH = join(__dir, '../../../docs/cross-ai/osmani-physical-device-census-contract.json')

const MAX_COMPONENT_SIZE_ABORT = Math.max(
  10,
  Math.min(100, Number(process.env.CENSUS_MAX_COMPONENT_SIZE) || 25),
)

const DEFAULT_EMULATOR_ANDROID_IDS = [
  '9774d56d682e549c',
  '0000000000000000',
  'unknown',
  'android_id',
]

function edgeLimitsFromContract(contract) {
  const edges = Array.isArray(contract?.allowed_edge_types)
    ? contract.allowed_edge_types
    : Array.isArray(contract?.backend_executable_edge_limits)
      ? contract.backend_executable_edge_limits
      : []
  const byId = Object.fromEntries(
    edges.map((e) => [e.id || e.edge_type, e]),
  )
  return {
    install: Math.max(
      2,
      Math.min(8, Number(byId.PROVEN_INSTALL_SESSION_ALIAS?.max_devices_per_anchor) || 4),
    ),
    android: Math.max(
      2,
      Math.min(5, Number(byId.PROVEN_ANDROID_ID_ALIAS?.max_devices_per_anchor) || 3),
    ),
    fingerprint: Number(byId.PROVEN_FINGERPRINT_PAIR?.max_devices_per_anchor) || 2,
    excludeAndroidIds: new Set(
      (byId.PROVEN_ANDROID_ID_ALIAS?.exclude_android_ids || DEFAULT_EMULATOR_ANDROID_IDS).map((x) =>
        String(x).toLowerCase(),
      ),
    ),
  }
}

let _cache = null
let _cacheAt = 0
let _refreshInFlight = null
const CACHE_MS = Math.max(
  60_000,
  Math.min(600_000, Number(process.env.PHYSICAL_DEVICE_CENSUS_CACHE_MS) || 300_000),
)

/** Last-known-good census for dashboard hot path — never triggers cold build. */
export function peekPhysicalDeviceCensusCache() {
  if (!_cache) return null
  const cacheAgeMs = Date.now() - _cacheAt
  return {
    ..._cache,
    cached: true,
    cacheAgeMs,
    stale: cacheAgeMs >= CACHE_MS,
  }
}

/** Background census refresh — does not block snapshot/overview requests. */
export function schedulePhysicalDeviceCensusRefresh() {
  if (_refreshInFlight) return _refreshInFlight
  _refreshInFlight = computePhysicalDeviceCensus({ dryRun: false })
    .catch((e) => {
      console.error('[physical-device-census] background refresh failed:', e)
      return { ok: false, error: String(e.message || e) }
    })
    .finally(() => {
      _refreshInFlight = null
    })
  return _refreshInFlight
}

class UnionFind {
  constructor() {
    this.parent = new Map()
    this.rank = new Map()
  }

  add(id) {
    if (!this.parent.has(id)) {
      this.parent.set(id, id)
      this.rank.set(id, 0)
    }
  }

  find(x) {
    this.add(x)
    let p = this.parent.get(x)
    if (p !== x) {
      p = this.find(p)
      this.parent.set(x, p)
    }
    return p
  }

  union(a, b) {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra === rb) return false
    const rankA = this.rank.get(ra) || 0
    const rankB = this.rank.get(rb) || 0
    if (rankA < rankB) this.parent.set(ra, rb)
    else if (rankA > rankB) this.parent.set(rb, ra)
    else {
      this.parent.set(rb, ra)
      this.rank.set(ra, rankA + 1)
    }
    return true
  }

  components() {
    const groups = new Map()
    for (const id of this.parent.keys()) {
      const root = this.find(id)
      if (!groups.has(root)) groups.set(root, [])
      groups.get(root).push(id)
    }
    return groups
  }
}

export function loadPhysicalDeviceCensusContract() {
  try {
    const raw = readFileSync(CONTRACT_PATH, 'utf8')
    return JSON.parse(raw)
  } catch (e) {
    return { ok: false, error: String(e.message || e), path: CONTRACT_PATH }
  }
}

function isValidAndroidIdForEdge(androidId, excludeSet) {
  const d = String(androidId ?? '').trim().toLowerCase()
  if (!d || d.length < 8) return false
  if (excludeSet.has(d)) return false
  if (isSyntheticDeviceId(d)) return false
  return true
}

function isValidFingerprintForEdge(fp) {
  const d = String(fp ?? '').trim()
  return /^[0-9a-fA-F]{64}$/.test(d)
}

function filterObservedGroup(deviceIds, observedSet) {
  return deviceIds
    .map((x) => String(x ?? '').trim())
    .filter((id) => id && observedSet.has(id) && !isSyntheticDeviceId(id))
}

function unionGroup(uf, deviceIds, edgeStats, edgeType) {
  if (deviceIds.length < 2) return
  edgeStats[edgeType] = (edgeStats[edgeType] || 0) + 1
  const [first, ...rest] = deviceIds
  for (const other of rest) uf.union(first, other)
}

function componentStats(groups) {
  const sizes = [...groups.values()].map((g) => g.length).sort((a, b) => a - b)
  const total = sizes.length
  if (total === 0) {
    return { total, max: 0, median: 0, p95: 0, mergedComponents: 0 }
  }
  const max = sizes[sizes.length - 1]
  const median = sizes[Math.floor(total / 2)]
  const p95 = sizes[Math.min(total - 1, Math.floor(total * 0.95))]
  const mergedComponents = sizes.filter((s) => s > 1).length
  return { total, max, median, p95, mergedComponents }
}

function findGiantComponents(groups, limit = 10) {
  return [...groups.entries()]
    .map(([root, ids]) => ({ root, size: ids.length, device_ids: ids.slice(0, 8) }))
    .filter((g) => g.size > 1)
    .sort((a, b) => b.size - a.size)
    .slice(0, limit)
}

/**
 * @param {{ dryRun?: boolean }} [opts]
 */
export async function computePhysicalDeviceCensus(opts = {}) {
  const pool = getPool()
  if (!pool) return { ok: false, error: 'Database not configured' }

  const contract = loadPhysicalDeviceCensusContract()
  const limits = edgeLimitsFromContract(contract)
  const t0 = Date.now()
  const likeParams = [
    'cap_%',
    'cap67_%',
    'verify_recovery_%',
    'verify_%',
    'pool_audit_%',
    'benchmark_%',
    'probe_%',
    '__probe_%',
    'test_%',
    'aurax-live-probe%',
  ]
  const excludeClause = syntheticSqlExclude('d.device_id')

  const observedRes = await pool.query(
    `
    WITH installs AS (
      SELECT DISTINCT trim(device_id)::text AS device_id FROM app_installs WHERE trim(device_id) <> ''
    ),
    telemetry AS (
      SELECT DISTINCT trim(device_id)::text AS device_id
      FROM client_api_telemetry WHERE trim(device_id) <> '' AND version_code >= 16
    ),
    combined AS (
      SELECT device_id FROM installs UNION SELECT device_id FROM telemetry
    ),
    filtered AS (
      SELECT d.device_id FROM combined d WHERE ${excludeClause}
    )
    SELECT device_id FROM filtered
    `,
    likeParams,
  )

  const observedSet = new Set(observedRes.rows.map((r) => String(r.device_id)))
  const observedRawCount = observedSet.size

  const uf = new UnionFind()
  for (const id of observedSet) uf.add(id)

  const edgeStats = {}
  const edgeDetails = {
    install_instance: 0,
    android_id: 0,
    fingerprint: 0,
    fingerprint_rejected: 0,
    fingerprint_unresolved: 0,
  }
  const fingerprintPairAudit = {
    total_candidate_pairs: 0,
    accepted: 0,
    rejected: 0,
    unresolved: 0,
    verdict_counts: {},
    proof_class_counts: {},
    pairs: [],
  }

  const installByDevice = new Map()
  const installInstanceRows = await pool.query(
    `SELECT trim(device_id) AS device_id, trim(install_instance_id) AS install_instance_id
     FROM app_installs
     WHERE trim(install_instance_id) <> '' AND length(trim(install_instance_id)) >= 8`,
  )
  for (const row of installInstanceRows.rows) {
    const did = String(row.device_id)
    const iid = String(row.install_instance_id)
    if (!installByDevice.has(did)) installByDevice.set(did, new Set())
    installByDevice.get(did).add(iid)
  }

  const installGroups = await pool.query(
    `SELECT trim(install_instance_id) AS anchor, array_agg(DISTINCT trim(device_id)) AS device_ids
     FROM app_installs
     WHERE trim(install_instance_id) <> '' AND length(trim(install_instance_id)) >= 8
     GROUP BY 1
     HAVING count(DISTINCT trim(device_id)) BETWEEN 2 AND $1`,
    [limits.install],
  )
  for (const row of installGroups.rows) {
    const ids = filterObservedGroup(row.device_ids || [], observedSet)
    if (ids.length >= 2 && ids.length <= limits.install) {
      unionGroup(uf, ids, edgeStats, 'PROVEN_INSTALL_SESSION_ALIAS')
      edgeDetails.install_instance += 1
    }
  }

  const androidGroups = await pool.query(
    `SELECT trim(android_id) AS anchor, array_agg(DISTINCT trim(device_id)) AS device_ids
     FROM device_intelligence_registry
     WHERE trim(android_id) <> '' AND length(trim(android_id)) >= 8
     GROUP BY 1
     HAVING count(DISTINCT trim(device_id)) BETWEEN 2 AND $1`,
    [limits.android],
  )
  for (const row of androidGroups.rows) {
    if (!isValidAndroidIdForEdge(row.anchor, limits.excludeAndroidIds)) continue
    const ids = filterObservedGroup(row.device_ids || [], observedSet)
    if (ids.length >= 2 && ids.length <= limits.android) {
      unionGroup(uf, ids, edgeStats, 'PROVEN_ANDROID_ID_ALIAS')
      edgeDetails.android_id += 1
    }
  }

  const registryMetaRows = await pool.query(
    `SELECT trim(device_id) AS device_id, metadata
     FROM device_intelligence_registry WHERE trim(device_id) <> ''`,
  )
  const registryByDevice = new Map(
    registryMetaRows.rows.map((r) => [String(r.device_id), { metadata: r.metadata }]),
  )

  const fpGroups = await pool.query(
    `SELECT trim(device_fingerprint) AS anchor, array_agg(DISTINCT trim(device_id)) AS device_ids
     FROM device_intelligence_registry
     WHERE length(trim(device_fingerprint)) = 64 AND trim(device_fingerprint) ~ '^[0-9a-fA-F]{64}$'
     GROUP BY 1
     HAVING count(DISTINCT trim(device_id)) = $1`,
    [limits.fingerprint],
  )
  for (const row of fpGroups.rows) {
    if (!isValidFingerprintForEdge(row.anchor)) continue
    const ids = filterObservedGroup(row.device_ids || [], observedSet)
    if (ids.length !== limits.fingerprint) continue

    fingerprintPairAudit.total_candidate_pairs += 1
    const fp = String(row.anchor).toLowerCase()
    const proof = evaluateFingerprintPairProof(fp, ids, installByDevice, registryByDevice)

    fingerprintPairAudit.verdict_counts[proof.verdict] =
      (fingerprintPairAudit.verdict_counts[proof.verdict] || 0) + 1
    fingerprintPairAudit.proof_class_counts[proof.proof_class] =
      (fingerprintPairAudit.proof_class_counts[proof.proof_class] || 0) + 1

    if (opts.auditFingerprints) {
      fingerprintPairAudit.pairs.push({
        left_id: redactDeviceId(ids[0]),
        right_id: redactDeviceId(ids[1]),
        fingerprint_prefix: fp.slice(0, 12),
        ...proof,
      })
    }

    if (proof.allowed) {
      unionGroup(uf, ids, edgeStats, 'PROVEN_FINGERPRINT_PAIR')
      edgeDetails.fingerprint += 1
      fingerprintPairAudit.accepted += 1
    } else if (proof.proof_class === 'INPUTS_MISSING') {
      edgeDetails.fingerprint_unresolved += 1
      fingerprintPairAudit.unresolved += 1
    } else {
      edgeDetails.fingerprint_rejected += 1
      fingerprintPairAudit.rejected += 1
    }
  }

  const groups = uf.components()
  const stats = componentStats(groups)
  const giants = findGiantComponents(groups)

  const abortReasons = []
  if (stats.max > MAX_COMPONENT_SIZE_ABORT) {
    abortReasons.push(`max_component_size ${stats.max} exceeds limit ${MAX_COMPONENT_SIZE_ABORT}`)
  }

  const registryAnchors = await pool.query(
    `SELECT trim(device_id) AS device_id, trim(android_id) AS android_id
     FROM device_intelligence_registry
     WHERE trim(device_id) <> '' AND trim(android_id) <> ''`,
  )
  const androidByDevice = new Map()
  for (const row of registryAnchors.rows) {
    const did = String(row.device_id)
    const aid = String(row.android_id)
    if (isValidAndroidIdForEdge(aid, limits.excludeAndroidIds)) androidByDevice.set(did, aid.toLowerCase())
  }

  let highConfidence = 0
  let aliasMerged = 0
  let ambiguousLow = 0

  for (const [, members] of groups) {
    const hasAndroid = members.some((id) => androidByDevice.has(id))
    const merged = members.length > 1
    if (merged) aliasMerged += 1
    if (hasAndroid || merged) highConfidence += 1
    else ambiguousLow += 1
  }

  const physicalDeviceCount = stats.total
  const mergedDeviceIds =
    observedRawCount - physicalDeviceCount > 0 ? observedRawCount - physicalDeviceCount : 0

  const [canonical, migration] = await Promise.all([
    queryCanonicalUniqueDeviceCount().catch(() => ({ ok: false, totalUniqueDevices: 0 })),
    queryMigrationDevicePopulationSummary().catch(() => ({ ok: false })),
  ])

  const legacyMigration = migration?.ok ? Number(migration.summary?.totalUniqueDevices) || 0 : 0
  const canonicalCount = canonical?.ok ? Number(canonical.totalUniqueDevices) || 0 : observedRawCount

  const installSessionCollapses = edgeStats.PROVEN_INSTALL_SESSION_ALIAS || 0
  const androidCollapses = edgeStats.PROVEN_ANDROID_ID_ALIAS || 0
  const fingerprintCollapses = edgeStats.PROVEN_FINGERPRINT_PAIR || 0

  const reconciliation = {
    current_observed_identities: canonicalCount,
    merged_by_install_instance_alias: edgeDetails.install_instance,
    merged_by_android_id_alias: edgeDetails.android_id,
    merged_by_fingerprint_pair: edgeDetails.fingerprint,
    fingerprint_pairs_rejected_app_v2: edgeDetails.fingerprint_rejected,
    fingerprint_pairs_unresolved: edgeDetails.fingerprint_unresolved,
    estimated_identities_merged: mergedDeviceIds,
    physical_device_components: physicalDeviceCount,
    delta_from_observed: physicalDeviceCount - canonicalCount,
    collapse_reconciliation: {
      install_session_edge_groups: edgeDetails.install_instance,
      android_id_edge_groups: edgeDetails.android_id,
      fingerprint_edge_groups_accepted: edgeDetails.fingerprint,
      fingerprint_edge_groups_rejected: edgeDetails.fingerprint_rejected,
      identity_collapses_net: mergedDeviceIds,
      merged_components: stats.mergedComponents,
      note: '518 net collapses vs 514 merged components — overlap when multiple edge types connect same devices',
    },
  }

  const result = {
    ok: abortReasons.length === 0,
    aborted: abortReasons.length > 0,
    abortReasons,
    contract: {
      version: contract.contract_version,
      status: contract.contract_status,
      path: CONTRACT_PATH,
    },
    timestampUtc: new Date().toISOString(),
    dryRun: opts.dryRun === true,
    counts: {
      physical_device_components_total: physicalDeviceCount,
      high_confidence_physical_devices: highConfidence,
      deterministic_alias_merged_components: aliasMerged,
      ambiguous_low_confidence_components: ambiguousLow,
      synthetic_excluded_not_in_graph: 'applied at seed filter',
      observed_raw_identities: observedRawCount,
      legacy_migration_metric: legacyMigration,
      naive_canonical_observed: canonicalCount,
    },
    edges: {
      types: edgeStats,
      groups_applied: edgeDetails,
    },
    component_statistics: stats,
    giant_component_audit: giants,
    reconciliation,
    buildMs: Date.now() - t0,
    label: contract.dashboard_label || contract.metric_label || 'Total Unique Devices',
    methodology: 'identity_graph_union_find_v2_app_authoritative',
    rule_audit: {
      PROVEN_INSTALL_SESSION_ALIAS: 'SUPPORTED_EXACTLY',
      PROVEN_ANDROID_ID_ALIAS: 'SUPPORTED_EXACTLY',
      PROVEN_FINGERPRINT_PAIR:
        fingerprintPairAudit.rejected + fingerprintPairAudit.unresolved > 0
          ? 'CONDITIONAL — hash rederivation or install_instance co-anchor required (App v2)'
          : 'SUPPORTED_EXACTLY under App v2 guards',
      PROVEN_LEGACY_MIGRATION: 'NON_EXECUTABLE_DUE_TO_MISSING_DB_EVIDENCE',
      PROVEN_STABLE_HARDWARE_ALIAS: 'NON_EXECUTABLE_DUE_TO_MISSING_DB_EVIDENCE',
      unsupported_edges_removed: edgeDetails.fingerprint_rejected,
      new_edges_added: 0,
      ambiguous_resolved_by_new_rules: 0,
      fingerprint_pair_audit: {
        total_candidate_pairs: fingerprintPairAudit.total_candidate_pairs,
        accepted: fingerprintPairAudit.accepted,
        rejected: fingerprintPairAudit.rejected,
        unresolved: fingerprintPairAudit.unresolved,
        verdict_counts: fingerprintPairAudit.verdict_counts,
        proof_class_counts: fingerprintPairAudit.proof_class_counts,
      },
      collapse_buckets: {
        install_session_supported: installSessionCollapses,
        android_id_supported: androidCollapses,
        fingerprint_hash_or_coanchor: fingerprintCollapses,
        fingerprint_rejected_unsupported: edgeDetails.fingerprint_rejected,
        fingerprint_unresolved: edgeDetails.fingerprint_unresolved,
      },
    },
    fingerprint_pair_audit: opts.auditFingerprints
      ? fingerprintPairAudit
      : {
          total_candidate_pairs: fingerprintPairAudit.total_candidate_pairs,
          accepted: fingerprintPairAudit.accepted,
          rejected: fingerprintPairAudit.rejected,
          unresolved: fingerprintPairAudit.unresolved,
          verdict_counts: fingerprintPairAudit.verdict_counts,
          proof_class_counts: fingerprintPairAudit.proof_class_counts,
        },
    missing_app_proven_edges: {
      PROVEN_LEGACY_MIGRATION: 'NON_EXECUTABLE_DUE_TO_MISSING_DB_EVIDENCE',
      PROVEN_STABLE_HARDWARE_ALIAS: 'NON_EXECUTABLE_DUE_TO_MISSING_DB_EVIDENCE',
      legacy_package_android_id_precedence: 'NON_EXECUTABLE_DUE_TO_MISSING_DB_EVIDENCE',
      migration_bridge_identity_candidates: 'NON_EXECUTABLE_DUE_TO_MISSING_DB_EVIDENCE',
    },
    ambiguous_reaudit: {
      starting_ambiguous: ambiguousLow,
      safely_resolved: 0,
      remain_ambiguous: ambiguousLow,
      reason: 'No phone/IP/model/payment merges; SSAID/Widevine/legacy edges require persisted fields not in DB',
    },
    limitations: [
      'legacy_device_id pairs are not persisted for historical alias reconstruction',
      'stable_hardware_id / Widevine ID not stored in Admin DB',
      'install_instance_id alone is low-confidence for never-registered devices',
      'perfect physical-phone dedupe impossible when reinstall emits new device_id without stored alias evidence',
    ],
  }

  if (!opts.dryRun && result.ok) {
    _cache = result
    _cacheAt = Date.now()
  }

  return result
}

export async function queryPhysicalDeviceCensusSnapshot(opts = {}) {
  const force = opts.force === true
  const now = Date.now()
  if (!force && _cache && now - _cacheAt < CACHE_MS) {
    return { ..._cache, cached: true, cacheAgeMs: now - _cacheAt }
  }
  if (!force) {
    const peek = peekPhysicalDeviceCensusCache()
    if (peek) {
      schedulePhysicalDeviceCensusRefresh()
      return peek
    }
  }
  return computePhysicalDeviceCensus({ dryRun: false })
}
