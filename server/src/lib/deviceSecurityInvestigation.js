import { getPool } from '../db/pool.js'
import {
  ensureDeviceSecurityTables,
  getPlaybackSecurityPolicy,
  getRiskDevice,
  isStrictEnforcementEnabled,
  RISK_WEIGHTS,
  SMART_MONITOR_REBLOCK_SCORE,
} from './deviceSecurityStore.js'

function text(v, max = 256) {
  return String(v ?? '')
    .trim()
    .slice(0, max)
}

/** Human-readable labels for detection reason keys (admin UI). */
const REASON_LABELS = {
  root_detected: 'Root detected',
  rooted: 'Root detected',
  jailbreak_ios: 'Jailbreak (iOS)',
  emulator_detected: 'Emulator detected',
  emulator: 'Emulator detected',
  clone_detected: 'Clone app detected',
  clone: 'Clone app detected',
  debug_detected: 'Debugger detected',
  debugger_attached: 'Debugger detected',
  debugger: 'Debugger detected',
  frida_detected: 'Frida detected',
  frida: 'Frida detected',
  hook_detected: 'Hook / instrumentation detected',
  resigned_apk: 'APK re-signed',
  tampered_apk: 'APK tampering detected',
  tampered: 'APK tampering detected',
  signature_mismatch: 'Signature mismatch',
  integrity_failure: 'Integrity failure',
  device_fingerprint_mismatch: 'Device fingerprint mismatch',
  fingerprint_mismatch: 'Device fingerprint mismatch',
  subscription_abuse: 'Subscription abuse',
  session_abuse: 'Session abuse',
  dev_client: 'Development client',
}

/** Simple Swahili explanations for non-technical admins. */
const SWAHILI_BY_KEY = {
  root_detected:
    'Mtumiaji huyu amefungiwa kwa sababu mfumo uligundua kifaa chake kina ROOT. Root inaweza kuruhusu kubadilisha tabia ya programu na kuondoa ulinzi wa malipo.',
  rooted:
    'Mtumiaji huyu amefungiwa kwa sababu mfumo uligundua kifaa chake kina ROOT. Root inaweza kuruhusu kubadilisha tabia ya programu na kuondoa ulinzi wa malipo.',
  jailbreak_ios:
    'Kifaa cha iOS kinaonekana kimefunguliwa (jailbreak). Hii inaweza kuharibu ulinzi wa programu na malipo.',
  emulator_detected:
    'Programu inaendeshwa kwenye emulator (kifaa bandia), si simu halisi. Emulator hutumika mara nyingi kujaribu kuepuka malipo au ulinzi.',
  emulator:
    'Programu inaendeshwa kwenye emulator (kifaa bandia), si simu halisi. Emulator hutumika mara nyingi kujaribu kuepuka malipo au ulinzi.',
  clone_detected:
    'Mfumo uligundua nakala ya programu (clone). Hii inaweza kuwa nakala iliyokopiwa ili kuepuka malipo au ulinzi.',
  clone:
    'Mfumo uligundua nakala ya programu (clone). Hii inaweza kuwa nakala iliyokopiwa ili kuepuka malipo au ulinzi.',
  debug_detected:
    'Zana za debugging zimegunduliwa. Zana hizi hutumika kuchunguza au kubadilisha tabia ya programu wakati inaendelea kufanya kazi.',
  debugger_attached:
    'Zana za debugging zimegunduliwa. Zana hizi hutumika kuchunguza au kubadilisha tabia ya programu wakati inaendelea kufanya kazi.',
  debugger:
    'Zana za debugging zimegunduliwa. Zana hizi hutumika kuchunguza au kubadilisha tabia ya programu wakati inaendelea kufanya kazi.',
  frida_detected:
    'Frida au debugging tools zimegunduliwa. Zana hizi hutumika kuchunguza au kubadilisha tabia ya programu wakati inaendelea kufanya kazi.',
  frida:
    'Frida au debugging tools zimegunduliwa. Zana hizi hutumika kuchunguza au kubadilisha tabia ya programu wakati inaendelea kufanya kazi.',
  hook_detected:
    'Mfumo uligundua uingiliaji wa programu (hooks). Hii inaweza kubadilisha tabia ya programu bila ruhusa.',
  resigned_apk:
    'Programu iliyotumika inaonekana imebadilishwa (APK tampering / re-sign). Hii mara nyingi hutokea pale mtu anapobadilisha APK rasmi kwa kutumia APK Editor au zana zinazofanana.',
  tampered_apk:
    'Programu iliyotumika inaonekana imebadilishwa (APK tampering). Hii mara nyingi hutokea pale mtu anapobadilisha APK rasmi kwa kutumia APK Editor au zana zinazofanana.',
  tampered:
    'Programu iliyotumika inaonekana imebadilishwa (APK tampering). Hii mara nyingi hutokea pale mtu anapobadilisha APK rasmi kwa kutumia APK Editor au zana zinazofanana.',
  signature_mismatch:
    'Sahihi ya programu (signature) hailingani na toleo rasmi. Hii inaashiria APK isiyo rasmi au iliyobadilishwa.',
  integrity_failure:
    'Ukaguzi wa uadilifu wa programu umeshindwa. Mfumo haukuamini kuwa programu ni halisi.',
  device_fingerprint_mismatch:
    'Alama ya kifaa (fingerprint) hailingani na rekodi za zamani. Hii inaweza kuashiria kubadilisha kifaa au jaribio la kuepuka ufuatiliaji.',
  fingerprint_mismatch:
    'Alama ya kifaa (fingerprint) hailingani na rekodi za zamani. Hii inaweza kuashiria kubadilisha kifaa au jaribio la kuepuka ufuatiliaji.',
  subscription_abuse:
    'Mfumo uligundua matumizi yasiyo ya kawaida ya usajili (subscription abuse). Hii inaweza kuhusiana na kujaribu kutumia malipo bila kulipa.',
  session_abuse:
    'Mfumo uligundua matumizi yasiyo ya kawaida ya kikao (session abuse). Hii inaweza kuhusiana na kushiriki akaunti au kuepuka vizuizi.',
  dev_client:
    'Programu inaonekana ni toleo la watengenezaji (dev client), si toleo rasmi la watumiaji.',
}

function normalizeReasonKey(riskType) {
  const t = String(riskType || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
  if (!t) return ''
  if (REASON_LABELS[t] || SWAHILI_BY_KEY[t]) return t
  if (t.endsWith('_detected')) return t
  const withDetected = `${t}_detected`
  if (REASON_LABELS[withDetected] || SWAHILI_BY_KEY[withDetected]) return withDetected
  return t
}

function labelForKey(key) {
  return REASON_LABELS[key] || key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function swahiliForKey(key) {
  return (
    SWAHILI_BY_KEY[key] ||
    SWAHILI_BY_KEY[normalizeReasonKey(key)] ||
    `Mfumo uligundua hatari ya usalama: ${labelForKey(key)}. Tafadhali wasiliana na msimamizi wa kiufundi ikiwa unahitaji maelezo zaidi.`
  )
}

function flagReasons(device) {
  const out = []
  const add = (key, detected) => {
    if (!detected) return
    const k = normalizeReasonKey(key)
    if (out.some((r) => r.key === k)) return
    out.push({
      key: k,
      label: labelForKey(k),
      source: 'flag',
      risk_score: RISK_WEIGHTS[k] ?? RISK_WEIGHTS[k.replace(/_detected$/, '')] ?? null,
    })
  }
  add('rooted', device.rooted)
  add('emulator', device.emulator)
  add('clone_detected', device.clone_detected)
  add('debugger', device.debugger)
  add('frida', device.frida)
  add('tampered_apk', device.tampered_apk)
  return out
}

function buildDetectionReasons(device) {
  const seen = new Set()
  const reasons = []

  for (const s of device.signals ?? []) {
    const key = normalizeReasonKey(s?.risk_type ?? s?.riskType)
    if (!key || seen.has(key)) continue
    seen.add(key)
    reasons.push({
      key,
      label: labelForKey(key),
      source: 'signal',
      risk_score: typeof s?.risk_score === 'number' ? s.risk_score : null,
      detail: s?.detail ? text(s.detail, 500) : null,
    })
  }

  for (const r of flagReasons(device)) {
    if (seen.has(r.key)) continue
    seen.add(r.key)
    reasons.push(r)
  }

  const meta = device.metadata && typeof device.metadata === 'object' ? device.metadata : {}
  for (const extraKey of [
    'signature_mismatch',
    'integrity_failure',
    'device_fingerprint_mismatch',
    'fingerprint_mismatch',
    'subscription_abuse',
    'session_abuse',
  ]) {
    if (meta[extraKey] === true || meta[extraKey] === 'true') {
      const key = normalizeReasonKey(extraKey)
      if (seen.has(key)) continue
      seen.add(key)
      reasons.push({ key, label: labelForKey(key), source: 'metadata', risk_score: null })
    }
  }

  if (!reasons.length && device.risk_type) {
    const key = normalizeReasonKey(device.risk_type)
    reasons.push({
      key,
      label: labelForKey(key),
      source: 'primary',
      risk_score: device.risk_score ?? null,
    })
  }

  return reasons
}

function buildSwahiliExplanations(reasons) {
  return reasons.map((r) => ({
    key: r.key,
    label: r.label,
    text: swahiliForKey(r.key),
  }))
}

function resolveEnforcementSummary(device, policy, strictEnabled) {
  const adminStatus = String(device.admin_status || device.status || 'monitoring')
  let finalAction = 'monitor'
  if (policy?.deny_playback) finalAction = 'block_playback'
  else if (adminStatus === 'whitelisted' || device.whitelisted) finalAction = 'whitelisted'
  else if (adminStatus === 'allowed') finalAction = 'allowed'
  else if (adminStatus === 'smart_monitor') finalAction = 'smart_monitor'
  else if (adminStatus === 'temp_block') finalAction = 'temporary_block'
  else if (adminStatus === 'perm_block' || device.admin_blocked) finalAction = 'permanent_block'
  else if (device.security_level === 'blocked' || device.security_level === 'critical') {
    finalAction = strictEnabled ? 'auto_block' : 'elevated_risk'
  }

  const blockState = policy?.deny_playback
    ? 'blocked'
    : adminStatus === 'whitelisted' || device.whitelisted
      ? 'whitelisted'
      : 'not_blocked'

  return { finalAction, blockState, playbackDenied: policy?.deny_playback === true }
}

function classifyTimelineEvent(row) {
  const et = String(row.event_type || '').toLowerCase()
  const action = String(row.metadata?.action || '')
  if (et.includes('detection') && !et.includes('changed')) return 'detection_created'
  if (et.includes('level changed')) return 'score_or_level_change'
  if (et.includes('bulk')) return 'manual_action'
  if (action === 'whitelist' || et.includes('whitelist')) return 'whitelist_action'
  if (
    action === 'remove_restriction' ||
    action === 'reset_risk' ||
    action === 'allow_device' ||
    action === 'unblock_user' ||
    et.includes('unblock')
  ) {
    return 'unblock_action'
  }
  if (action === 'enable_smart_monitor' || et.includes('smart monitor enable')) {
    return 'smart_monitor_enable'
  }
  if (action === 'disable_smart_monitor' || et.includes('smart monitor disable')) {
    return 'smart_monitor_disable'
  }
  if (
    action === 'block_user' ||
    action === 'temporary_block' ||
    action === 'permanent_block' ||
    et.includes('block') ||
    row.status === 'blocked'
  ) {
    return 'enforcement_applied'
  }
  if (et.includes('action') || et.includes('force logout')) return 'manual_action'
  if (row.metadata?.signals) return 'additional_signals'
  return 'security_event'
}

function timelineTitle(kind, row) {
  const et = String(row.event_type || '')
  const action = String(row.metadata?.action || '')
  switch (kind) {
    case 'detection_created':
      return 'Uchunguzi wa usalama umeanzishwa'
    case 'score_or_level_change':
      return 'Kiwango cha hatari kimebadilika'
    case 'additional_signals':
      return 'Ishara za ziada zimepokelewa'
    case 'enforcement_applied':
      return 'Hatua ya kuzuia imetekelezwa'
    case 'whitelist_action':
      return 'Kifaa kimeongezwa kwenye whitelist'
    case 'unblock_action':
      return 'Vizuizi vimeondolewa / hatari imesafishwa'
    case 'smart_monitor_enable':
      return 'Smart Monitor Mode imewashwa'
    case 'smart_monitor_disable':
      return 'Smart Monitor Mode imezimwa'
    case 'manual_action':
      return action ? `Hatua ya msimamizi: ${action.replace(/_/g, ' ')}` : et || 'Hatua ya msimamizi'
    default:
      return et || 'Tukio la usalama'
  }
}

async function fetchDeviceTimeline(pool, deviceId) {
  const d = text(deviceId, 128)
  const { rows } = await pool.query(
    `SELECT id, actor, event_type, status, detail, metadata, created_at
     FROM security_events
     WHERE actor = $1
        OR metadata->>'device_id' = $1
        OR detail ILIKE '%' || $1 || '%'
     ORDER BY created_at ASC
     LIMIT 500`,
    [d],
  )

  const events = rows.map((r) => {
    const kind = classifyTimelineEvent(r)
    const meta = r.metadata && typeof r.metadata === 'object' ? r.metadata : {}
    return {
      id: String(r.id),
      kind,
      title: timelineTitle(kind, r),
      at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at || ''),
      actor: String(r.actor || ''),
      status: String(r.status || ''),
      detail: String(r.detail || ''),
      risk_score: meta.risk_score ?? null,
      security_level: meta.security_level ?? null,
      action: meta.action ?? null,
    }
  })

  return events
}

function seedProfileTimelineEvents(device, events) {
  const seeded = [...events]
  const hasDetection = seeded.some((e) => e.kind === 'detection_created')
  if (!hasDetection && device.first_seen && Number(device.risk_score) > 0) {
    seeded.unshift({
      id: `profile-first-${device.device_id}`,
      kind: 'detection_created',
      title: 'Kifaa kimeandikishwa kwenye mfumo wa usalama',
      at: device.first_seen,
      actor: device.device_id,
      status: device.security_level || 'warning',
      detail: `Rekodi ya kwanza — alama kuu: ${device.risk_type || '—'}`,
      risk_score: device.risk_score,
      security_level: device.security_level,
      action: null,
      synthetic: true,
    })
  }
  seeded.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
  return seeded
}

function buildAuditSummary(device, timeline) {
  const unblockEvents = timeline.filter((e) => e.kind === 'unblock_action')
  const blockEvents = timeline.filter((e) => e.kind === 'enforcement_applied')
  const smartMonitorEvents = timeline.filter((e) => e.kind === 'smart_monitor_enable')
  const lastUnblock = unblockEvents[unblockEvents.length - 1]
  const lastBlock = blockEvents[blockEvents.length - 1]
  const lastSmartMonitor = smartMonitorEvents[smartMonitorEvents.length - 1]

  const threatKey = device.rooted
    ? 'rooted'
    : device.emulator
      ? 'emulator'
      : device.tampered_apk
        ? 'tampered_apk'
        : device.frida
          ? 'frida'
          : String(device.risk_type || '').toLowerCase() || null

  const blockReasonSwahili = threatKey
    ? {
        rooted: 'Kifaa kimefungwa kwa sababu ya ROOT',
        root_detected: 'Kifaa kimefungwa kwa sababu ya ROOT',
        emulator: 'Kifaa kimefungwa kwa sababu ya Emulator',
        emulator_detected: 'Kifaa kimefungwa kwa sababu ya Emulator',
        tampered_apk: 'Kifaa kimefungwa kwa sababu ya APK isiyo rasmi',
        frida: 'Kifaa kimefungwa kwa sababu ya uingiliaji wa programu',
      }[threatKey] || `Kifaa kimefungwa kwa sababu ya ${threatKey.replace(/_/g, ' ')}`
    : lastBlock?.detail || 'Hatari ya usalama iligunduliwa'

  return {
    blocked_by: device.blocked_by || lastBlock?.actor || null,
    blocked_at: device.blocked_at || lastBlock?.at || null,
    block_reason_swahili: blockReasonSwahili,
    unblocked_by: device.unblocked_by || lastUnblock?.actor || null,
    unblocked_at: device.unblocked_at || lastUnblock?.at || null,
    unblock_reason_swahili: lastUnblock ? 'Admin ameondoa block' : null,
    smart_monitor_enabled_at: lastSmartMonitor?.at || null,
    smart_monitor_enabled_by: lastSmartMonitor?.actor || null,
    smart_monitor_swahili: device.smart_monitor_enabled
      ? 'Smart Monitor imewashwa — kifaa kinafuatiliwa'
      : null,
  }
}

function buildRawEvidence(device, policy, strictEnabled) {
  const meta = device.metadata && typeof device.metadata === 'object' ? device.metadata : {}
  return {
    detection_flags: {
      rooted: device.rooted === true,
      emulator: device.emulator === true,
      clone_detected: device.clone_detected === true,
      debugger: device.debugger === true,
      frida: device.frida === true,
      tampered_apk: device.tampered_apk === true,
    },
    internal_signals: device.signals ?? [],
    security_payload: meta,
    integrity_results: {
      integrity_failure: meta.integrity_failure ?? null,
      signature_mismatch: meta.signature_mismatch ?? null,
      device_fingerprint_mismatch: meta.device_fingerprint_mismatch ?? meta.fingerprint_mismatch ?? null,
    },
    signature_checks: {
      resigned_apk: device.signals?.some((s) =>
        String(s?.risk_type || '').toLowerCase().includes('resign'),
      ),
      tampered_apk: device.tampered_apk === true,
      metadata_signature: meta.signature ?? meta.signature_check ?? null,
    },
    playback_policy: policy,
    strict_enforcement_enabled: strictEnabled,
    admin_status: device.admin_status,
    temp_block_until: device.temp_block_until ?? null,
    block_reason: device.block_reason ?? null,
    smart_monitor_enabled: device.smart_monitor_enabled === true,
    blocked_at: device.blocked_at ?? null,
    blocked_by: device.blocked_by ?? null,
    unblocked_at: device.unblocked_at ?? null,
    unblocked_by: device.unblocked_by ?? null,
  }
}

/**
 * Read-only investigation bundle for admin Security Center.
 * Does not mutate profiles, scoring, or enforcement.
 */
export async function getDeviceSecurityInvestigationReport(deviceId) {
  const pool = getPool()
  if (!pool) throw new Error('Database not configured')
  await ensureDeviceSecurityTables(pool)

  const device = await getRiskDevice(deviceId)
  if (!device) return null

  const policy = await getPlaybackSecurityPolicy(deviceId)
  const strictEnabled = await isStrictEnforcementEnabled(pool)
  const { finalAction, blockState, playbackDenied } = resolveEnforcementSummary(
    device,
    policy,
    strictEnabled,
  )

  const detectionReasons = buildDetectionReasons(device)
  const swahiliExplanations = buildSwahiliExplanations(detectionReasons)
  const timeline = seedProfileTimelineEvents(
    device,
    await fetchDeviceTimeline(pool, deviceId),
  )
  const auditSummary = buildAuditSummary(device, timeline)

  return {
    read_only: true,
    generated_at: new Date().toISOString(),
    device_information: {
      device_id: device.device_id,
      phone_number: device.phone_user || device.phone || '',
      app_version: device.app_version || '',
      first_seen: device.first_seen || '',
      last_seen: device.last_seen || '',
      current_status: device.status || device.admin_status || 'monitoring',
      risk_score: device.risk_score ?? 0,
      blocked: device.blocked === true,
      smart_monitor_enabled: device.smart_monitor_enabled === true,
      blocked_at: device.blocked_at ?? null,
      blocked_by: device.blocked_by ?? null,
      unblocked_at: device.unblocked_at ?? null,
      unblocked_by: device.unblocked_by ?? null,
    },
    detection_summary: {
      risk_level: device.security_level || 'warning',
      final_enforcement_action: finalAction,
      detection_timestamp: device.detection_time || device.first_seen || device.last_seen || '',
      current_block_state: blockState,
      playback_denied: playbackDenied,
      strict_enforcement: strictEnabled,
      smart_monitor_enabled: device.smart_monitor_enabled === true,
      smart_monitor_reblock_score: SMART_MONITOR_REBLOCK_SCORE,
    },
    detection_reasons: detectionReasons,
    swahili_explanations: swahiliExplanations,
    security_timeline: timeline,
    audit_summary: auditSummary,
    raw_evidence: buildRawEvidence(device, policy, strictEnabled),
  }
}
