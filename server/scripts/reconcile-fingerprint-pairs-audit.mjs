#!/usr/bin/env node
/**
 * Cross-repo physical device census reconciliation — fingerprint pair audit.
 * Classifies each PROVEN_FINGERPRINT_PAIR group per App authoritative v2 contract.
 */
import crypto from 'node:crypto'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import '../src/loadEnv.js'
import { getPool } from '../src/db/pool.js'
import { isSyntheticDeviceId, syntheticSqlExclude } from '../src/lib/canonicalUniqueDevices.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(__dir, '../../docs/cross-ai/reconciliation-fingerprint-audit.json')

const PACKAGE_CURRENT = 'com.burudanitv.app'
const PACKAGE_LEGACY = 'com.osmantv.app'

function sha256Hex(input) {
  return createHash('sha256').update(String(input), 'utf8').digest('hex')
}

function redactId(id) {
  const s = String(id ?? '')
  if (s.length <= 12) return `r_${sha256Hex(s).slice(0, 8)}`
  return `${s.slice(0, 4)}…${s.slice(-4)}#${sha256Hex(s).slice(0, 8)}`
}

function tryEraA(deviceId, installInstanceId) {
  if (!deviceId || !installInstanceId) return null
  return sha256Hex(`${deviceId}|${PACKAGE_CURRENT}|${installInstanceId}`)
}

function tryEraC(subscriptionDeviceId, installInstanceId) {
  if (!subscriptionDeviceId || !installInstanceId) return null
  return sha256Hex(`${subscriptionDeviceId}|${PACKAGE_CURRENT}|${installInstanceId}`)
}

function tryLegacy(legacyId, installInstanceId) {
  if (!legacyId || !installInstanceId) return null
  return sha256Hex(`${legacyId}|${PACKAGE_LEGACY}|${installInstanceId}`)
}

function classifyPairProof(left, right, fp, installByDevice) {
  const leftInstalls = installByDevice.get(left.device_id) || new Set()
  const rightInstalls = installByDevice.get(right.device_id) || new Set()
  const sharedInstall = [...leftInstalls].filter((i) => rightInstalls.has(i))

  const metaLeft = left.metadata && typeof left.metadata === 'object' ? left.metadata : {}
  const metaRight = right.metadata && typeof right.metadata === 'object' ? right.metadata : {}
  const metaInstallLeft = String(
    metaLeft.install_instance_id ?? metaLeft.installInstanceId ?? '',
  ).trim()
  const metaInstallRight = String(
    metaRight.install_instance_id ?? metaRight.installInstanceId ?? '',
  ).trim()

  const hashAttempts = []
  const allInstalls = new Set([
    ...leftInstalls,
    ...rightInstalls,
    ...(metaInstallLeft ? [metaInstallLeft] : []),
    ...(metaInstallRight ? [metaInstallRight] : []),
  ])

  for (const iid of allInstalls) {
    for (const did of [left.device_id, right.device_id]) {
      const eraA = tryEraA(did, iid)
      if (eraA === fp) hashAttempts.push({ formula: 'era_a', device: did, install: iid })
      const eraC = tryEraC(did, iid)
      if (eraC === fp) hashAttempts.push({ formula: 'era_c', device: did, install: iid })
      const leg = tryLegacy(did, iid)
      if (leg === fp) hashAttempts.push({ formula: 'legacy', device: did, install: iid })
    }
  }

  const hasHash = hashAttempts.length > 0
  const hasCoAnchor = sharedInstall.length > 0

  let verdict = 'UNSUPPORTED'
  if (hasHash && hasCoAnchor) verdict = 'SUPPORTED_EXACTLY'
  else if (hasHash) verdict = 'CONDITIONAL_BUT_PROVEN'
  else if (hasCoAnchor) verdict = 'CONDITIONAL_BUT_PROVEN'
  else if (allInstalls.size === 0) verdict = 'INPUTS_MISSING'
  else verdict = 'UNSUPPORTED'

  return {
    left_id: redactId(left.device_id),
    right_id: redactId(right.device_id),
    fingerprint_prefix: String(fp).slice(0, 12),
    shared_install_instance: sharedInstall.length > 0,
    shared_install_count: sharedInstall.length,
    hash_rederivation_match: hasHash,
    hash_matches: hashAttempts.length,
    install_instance_coanchor: hasCoAnchor,
    left_install_count: leftInstalls.size,
    right_install_count: rightInstalls.size,
    left_android_id: left.android_id ? redactId(left.android_id) : null,
    right_android_id: right.android_id ? redactId(right.android_id) : null,
    left_app_version: left.app_version || null,
    right_app_version: right.app_version || null,
    verdict,
    proof_class:
      hasHash && hasCoAnchor
        ? 'BOTH'
        : hasHash
          ? 'HASH_REDERIVATION_MATCH'
          : hasCoAnchor
            ? 'INSTALL_INSTANCE_COANCHOR'
            : allInstalls.size === 0
              ? 'INPUTS_MISSING'
              : 'NO_PROOF',
  }
}

async function main() {
  const pool = getPool()
  if (!pool) {
    console.error('DATABASE_URL required')
    process.exit(2)
  }

  const excludeClause = syntheticSqlExclude('d.device_id')
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

  const observedRes = await pool.query(
    `
    WITH installs AS (
      SELECT DISTINCT trim(device_id)::text AS device_id FROM app_installs WHERE trim(device_id) <> ''
    ),
    telemetry AS (
      SELECT DISTINCT trim(device_id)::text AS device_id
      FROM client_api_telemetry WHERE trim(device_id) <> '' AND version_code >= 16
    ),
    combined AS (SELECT device_id FROM installs UNION SELECT device_id FROM telemetry),
    filtered AS (SELECT d.device_id FROM combined d WHERE ${excludeClause})
    SELECT device_id FROM filtered
    `,
    likeParams,
  )
  const observedSet = new Set(observedRes.rows.map((r) => String(r.device_id)))

  const fpGroups = await pool.query(
    `SELECT trim(device_fingerprint) AS fp, array_agg(DISTINCT trim(device_id)) AS device_ids
     FROM device_intelligence_registry
     WHERE length(trim(device_fingerprint)) = 64 AND trim(device_fingerprint) ~ '^[0-9a-fA-F]{64}$'
     GROUP BY 1
     HAVING count(DISTINCT trim(device_id)) = 2`,
  )

  const installRows = await pool.query(
    `SELECT trim(device_id) AS device_id, trim(install_instance_id) AS install_instance_id
     FROM app_installs
     WHERE trim(install_instance_id) <> '' AND length(trim(install_instance_id)) >= 8`,
  )
  const installByDevice = new Map()
  for (const row of installRows.rows) {
    const did = String(row.device_id)
    const iid = String(row.install_instance_id)
    if (!installByDevice.has(did)) installByDevice.set(did, new Set())
    installByDevice.get(did).add(iid)
  }

  const pairs = []
  const verdictCounts = {}
  const proofCounts = {}

  for (const row of fpGroups.rows) {
    const fp = String(row.fp).toLowerCase()
    const ids = (row.device_ids || [])
      .map((x) => String(x).trim())
      .filter((id) => observedSet.has(id) && !isSyntheticDeviceId(id))
    if (ids.length !== 2) continue

    const reg = await pool.query(
      `SELECT trim(device_id) AS device_id, trim(android_id) AS android_id,
              trim(app_version) AS app_version, metadata
       FROM device_intelligence_registry WHERE trim(device_id) = ANY($1::text[])`,
      [ids],
    )
    const byId = Object.fromEntries(reg.rows.map((r) => [String(r.device_id), r]))
    const left = byId[ids[0]]
    const right = byId[ids[1]]
    if (!left || !right) continue

    const audit = classifyPairProof(left, right, fp, installByDevice)
    pairs.push(audit)
    verdictCounts[audit.verdict] = (verdictCounts[audit.verdict] || 0) + 1
    proofCounts[audit.proof_class] = (proofCounts[audit.proof_class] || 0) + 1
  }

  const supported = pairs.filter(
    (p) => p.verdict === 'SUPPORTED_EXACTLY' || p.verdict === 'CONDITIONAL_BUT_PROVEN',
  ).length
  const unsupported = pairs.filter((p) => p.verdict === 'UNSUPPORTED').length
  const inputsMissing = pairs.filter((p) => p.verdict === 'INPUTS_MISSING').length

  const report = {
    generated_at_utc: new Date().toISOString(),
    contract_reference: '2026-07-05-app-authoritative-v2',
    app_commit: '89f840b9f1b9b2295b81810328f2c02bf59106e1',
    total_fingerprint_pairs: pairs.length,
    verdict_counts: verdictCounts,
    proof_class_counts: proofCounts,
    supported_merge_count: supported,
    unsupported_merge_count: unsupported,
    inputs_missing_count: inputsMissing,
    app_contract_verdict:
      unsupported + inputsMissing > 0
        ? 'PROVEN_FINGERPRINT_PAIR_TOO_BROAD — tighten required'
        : 'PROVEN_FINGERPRINT_PAIR acceptable under v2 guards',
    pairs,
  }

  writeFileSync(OUT, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({
    total: pairs.length,
    supported,
    unsupported,
    inputsMissing,
    verdictCounts,
    proofCounts,
    out: OUT,
  }, null, 2))

  await pool.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
