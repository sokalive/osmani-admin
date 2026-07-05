/**
 * App authoritative v2 guards for PROVEN_FINGERPRINT_PAIR merges.
 * Formulas from docs/cross-ai/osmani-physical-device-census-contract.json (App @ 89f840b).
 */
import { createHash } from 'node:crypto'

const PACKAGE_CURRENT = 'com.burudanitv.app'
const PACKAGE_LEGACY = 'com.osmantv.app'

export function sha256Hex(input) {
  return createHash('sha256').update(String(input), 'utf8').digest('hex')
}

export function redactDeviceId(id) {
  const s = String(id ?? '')
  if (!s) return ''
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

function installIdsFromMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return []
  const raw = metadata.install_instance_id ?? metadata.installInstanceId ?? ''
  const s = String(raw).trim()
  return s.length >= 8 ? [s] : []
}

/**
 * @param {string} fp lowercase hex fingerprint
 * @param {string[]} deviceIds exactly two device ids
 * @param {Map<string, Set<string>>} installByDevice
 * @param {Map<string, object>} registryByDevice device_id -> { metadata }
 */
export function evaluateFingerprintPairProof(fp, deviceIds, installByDevice, registryByDevice) {
  if (deviceIds.length !== 2) {
    return { allowed: false, proof_class: 'NO_PROOF', verdict: 'UNSUPPORTED' }
  }
  const [a, b] = deviceIds
  const leftInstalls = installByDevice.get(a) || new Set()
  const rightInstalls = installByDevice.get(b) || new Set()
  const sharedInstall = [...leftInstalls].filter((i) => rightInstalls.has(i))
  const hasCoAnchor = sharedInstall.length > 0

  const allInstalls = new Set([...leftInstalls, ...rightInstalls])
  for (const did of deviceIds) {
    for (const iid of installIdsFromMetadata(registryByDevice.get(did)?.metadata)) {
      allInstalls.add(iid)
    }
  }

  if (allInstalls.size === 0) {
    return {
      allowed: false,
      proof_class: 'INPUTS_MISSING',
      verdict: 'UNRESOLVED',
      hash_rederivation_match: false,
      install_instance_coanchor: false,
    }
  }

  let hashMatch = false
  for (const iid of allInstalls) {
    for (const did of deviceIds) {
      if (tryEraA(did, iid) === fp) hashMatch = true
      if (tryEraC(did, iid) === fp) hashMatch = true
      if (tryLegacy(did, iid) === fp) hashMatch = true
    }
  }

  const allowed = hashMatch || hasCoAnchor
  let proof_class = 'NO_PROOF'
  if (hashMatch && hasCoAnchor) proof_class = 'BOTH'
  else if (hashMatch) proof_class = 'HASH_REDERIVATION_MATCH'
  else if (hasCoAnchor) proof_class = 'INSTALL_INSTANCE_COANCHOR'

  let verdict = 'UNSUPPORTED'
  if (allowed) verdict = 'CONDITIONAL_BUT_PROVEN'
  if (hashMatch && hasCoAnchor) verdict = 'SUPPORTED_EXACTLY'

  return {
    allowed,
    proof_class,
    verdict,
    hash_rederivation_match: hashMatch,
    install_instance_coanchor: hasCoAnchor,
    shared_install_count: sharedInstall.length,
  }
}
