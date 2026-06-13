import { getDeviceSubscriptionAccessState } from '../billingStore.js'
import { getPool } from '../db/pool.js'
import {
  ensureDeviceSecurityTables,
  getPlaybackSecurityPolicy,
  getRiskDevice,
} from './deviceSecurityStore.js'

function text(v, max = 256) {
  return String(v ?? '')
    .trim()
    .slice(0, max)
}

const BLOCK_REASON_SWAHILI = {
  rooted: 'Kifaa Kimefungwa Kwa Sababu Ya Root',
  root_detected: 'Kifaa Kimefungwa Kwa Sababu Ya Root',
  emulator: 'Kifaa Kimefungwa Kwa Sababu Ya Emulator',
  emulator_detected: 'Kifaa Kimefungwa Kwa Sababu Ya Emulator',
  tampered_apk: 'Kifaa Kimefungwa Kwa Sababu Ya APK Isiyo Rasmi',
  tampered: 'Kifaa Kimefungwa Kwa Sababu Ya APK Isiyo Rasmi',
  resigned_apk: 'Kifaa Kimefungwa Kwa Sababu Ya APK Isiyo Rasmi',
  frida: 'Kifaa Kimefungwa Kwa Sababu Ya Uingiliaji Wa Programu (Frida)',
  frida_detected: 'Kifaa Kimefungwa Kwa Sababu Ya Uingiliaji Wa Programu (Frida)',
  clone_detected: 'Kifaa Kimefungwa Kwa Sababu Ya Clone App',
  debugger: 'Kifaa Kimefungwa Kwa Sababu Ya Debugger',
  admin_block: 'Kifaa Kimefungwa Na Msimamizi',
  manual_admin_blocked: 'Kifaa Kimefungwa Na Msimamizi (Manual Block)',
  intelligence_blocked: 'Kifaa Kimefungwa Kwenye Users Intelligence',
  security_level_blocked: 'Kifaa Kimefungwa Kwa Sababu Ya Hatari Ya Usalama',
}

function primaryThreatKey(device) {
  if (!device) return ''
  if (device.tampered_apk) return 'tampered_apk'
  if (device.emulator) return 'emulator'
  if (device.rooted) return 'rooted'
  if (device.frida) return 'frida'
  if (device.clone_detected) return 'clone_detected'
  if (device.debugger) return 'debugger'
  const sig = device.signals?.[0]
  const rt = String(sig?.risk_type || device.risk_type || '').toLowerCase()
  return rt || ''
}

function swahiliBlockReason(device, layers, policy) {
  if (layers.manual_admin_blocked) return BLOCK_REASON_SWAHILI.manual_admin_blocked
  if (layers.intelligence_blocked) return BLOCK_REASON_SWAHILI.intelligence_blocked
  if (layers.admin_devices_blocked) return BLOCK_REASON_SWAHILI.admin_block
  if (policy?.deny_playback && String(policy?.security_level) === 'blocked') {
    const key = primaryThreatKey(device)
    return BLOCK_REASON_SWAHILI[key] || BLOCK_REASON_SWAHILI.security_level_blocked
  }
  const key = primaryThreatKey(device)
  if (key && policy?.deny_playback) {
    return BLOCK_REASON_SWAHILI[key] || BLOCK_REASON_SWAHILI.security_level_blocked
  }
  return 'Hakuna sababu ya kufungiwa inayotumika'
}

async function fetchPlaybackLayers(pool, deviceId) {
  const d = text(deviceId, 128)
  const { rows } = await pool.query(
    `SELECT
       dsp.admin_status,
       dsp.security_level,
       dsp.blocked AS profile_blocked,
       dsp.smart_monitor_enabled,
       ad.is_blocked AS admin_devices_blocked,
       ad.block_reason AS admin_block_reason,
       ds.manual_admin_blocked,
       ir.status AS intelligence_status,
       ir.block_reason AS intelligence_block_reason
     FROM device_security_profiles dsp
     LEFT JOIN admin_devices ad ON ad.device_id = dsp.device_id
     LEFT JOIN device_subscriptions ds ON ds.device_id = dsp.device_id
     LEFT JOIN device_intelligence_registry ir ON ir.device_id = dsp.device_id
     WHERE dsp.device_id = $1
     LIMIT 1`,
    [d],
  )
  const r = rows[0]
  if (!r) {
    const sub = await pool.query(
      `SELECT ds.manual_admin_blocked, ad.is_blocked AS admin_devices_blocked,
              ir.status AS intelligence_status
       FROM device_subscriptions ds
       LEFT JOIN admin_devices ad ON ad.device_id = ds.device_id
       LEFT JOIN device_intelligence_registry ir ON ir.device_id = ds.device_id
       WHERE ds.device_id = $1 LIMIT 1`,
      [d],
    )
    const s = sub.rows[0]
    return {
      profile_blocked: false,
      admin_devices_blocked: s?.admin_devices_blocked === true,
      manual_admin_blocked: s?.manual_admin_blocked === true,
      intelligence_blocked: s?.intelligence_status === 'blocked',
      admin_status: null,
      security_level: null,
      smart_monitor_enabled: false,
    }
  }
  return {
    profile_blocked: r.profile_blocked === true,
    admin_devices_blocked: r.admin_devices_blocked === true,
    manual_admin_blocked: r.manual_admin_blocked === true,
    intelligence_blocked: r.intelligence_status === 'blocked',
    admin_status: r.admin_status ? String(r.admin_status) : null,
    security_level: r.security_level ? String(r.security_level) : null,
    smart_monitor_enabled: r.smart_monitor_enabled === true,
    admin_block_reason: r.admin_block_reason ? String(r.admin_block_reason) : '',
    intelligence_block_reason: r.intelligence_block_reason ? String(r.intelligence_block_reason) : '',
  }
}

/**
 * Post-action / on-demand verification: aggregates security profile, subscription access,
 * and playback policy into a Swahili admin summary.
 */
export async function getDeviceSecurityVerificationReport(deviceId) {
  const pool = getPool()
  if (!pool) throw new Error('Database not configured')
  await ensureDeviceSecurityTables(pool)

  const d = text(deviceId, 128)
  const device = await getRiskDevice(d)
  if (!device) return null

  const [policy, access, layers] = await Promise.all([
    getPlaybackSecurityPolicy(d),
    getDeviceSubscriptionAccessState(d),
    fetchPlaybackLayers(pool, d),
  ])

  const subscriptionBlocked = access?.blocked_now === true
  const securityDenied = policy?.deny_playback === true
  const playbackAllowed = !subscriptionBlocked && !securityDenied && access?.active_now === true

  const fullyOpen =
    !subscriptionBlocked &&
    !securityDenied &&
    !layers.manual_admin_blocked &&
    !layers.intelligence_blocked &&
    !layers.admin_devices_blocked &&
    !layers.profile_blocked

  let statusSwahili = 'Kifaa Bado Kimefungwa'
  let headlineSwahili = 'Kifaa Bado Kimefungwa'
  let sababuSwahili = swahiliBlockReason(device, layers, policy)

  if (fullyOpen && device.smart_monitor_enabled) {
    statusSwahili = 'Kifaa Kimefunguliwa'
    headlineSwahili = 'Kifaa Kimefunguliwa Kikamilifu'
    sababuSwahili = 'Admin Ameondoa Block'
  } else if (fullyOpen) {
    statusSwahili = 'Kifaa Kimefunguliwa'
    headlineSwahili = 'Kifaa Kimefunguliwa Kikamilifu'
    sababuSwahili = device.unblocked_by ? 'Admin Ameondoa Block' : 'Hakuna vizuizi vinavyotumika'
  } else if (!subscriptionBlocked && !securityDenied && access?.active_now === true) {
    statusSwahili = 'Kifaa Kimefunguliwa'
    headlineSwahili = 'Kifaa Kimefunguliwa Kikamilifu'
    sababuSwahili = 'Admin Ameondoa Block'
  } else if (!subscriptionBlocked && !securityDenied && access?.active_now !== true) {
    statusSwahili = 'Kifaa Kimefunguliwa'
    headlineSwahili = 'Kifaa Kimefunguliwa — Usajili Haupo'
    sababuSwahili = 'Usajili umeisha au haupo (si kizuizi cha usalama)'
  }

  const smartMonitorSwahili = device.smart_monitor_enabled
    ? 'Imewashwa'
    : layers.smart_monitor_enabled
      ? 'Imewashwa'
      : 'Imezimwa'

  const playbackSwahili = playbackAllowed ? 'Inaruhusiwa' : 'Hairuhusiwi'

  let denialLayer = 'none'
  if (layers.manual_admin_blocked) denialLayer = 'manual_admin_blocked'
  else if (layers.intelligence_blocked) denialLayer = 'intelligence_blocked'
  else if (layers.admin_devices_blocked) denialLayer = 'admin_devices_blocked'
  else if (layers.profile_blocked) denialLayer = 'profile_blocked'
  else if (securityDenied) denialLayer = 'security_level_blocked'
  else if (subscriptionBlocked) denialLayer = 'subscription_blocked_now'
  else if (access?.active_now !== true) denialLayer = 'subscription_inactive'

  if (device.smart_monitor_enabled && fullyOpen) {
    headlineSwahili = 'Kifaa Kinafuatiliwa Na Smart Monitor'
  }

  return {
    device_id: d,
    verified_at: new Date().toISOString(),
    status: statusSwahili,
    status_swahili: statusSwahili,
    headline: headlineSwahili,
    headline_swahili: headlineSwahili,
    sababu: sababuSwahili,
    sababu_swahili: sababuSwahili,
    smart_monitor: smartMonitorSwahili,
    smart_monitor_swahili: smartMonitorSwahili,
    playback: playbackSwahili,
    playback_swahili: playbackSwahili,
    playback_allowed: playbackAllowed,
    denial_layer: denialLayer,
    subscription_blocked: subscriptionBlocked,
    security_denied: securityDenied,
    layers: {
      device_security_profile: {
        admin_status: device.admin_status,
        security_level: device.security_level,
        blocked: device.blocked === true,
        smart_monitor_enabled: device.smart_monitor_enabled === true,
      },
      admin_devices: {
        is_blocked: layers.admin_devices_blocked,
        block_reason: layers.admin_block_reason || null,
      },
      device_subscriptions: {
        manual_admin_blocked: layers.manual_admin_blocked,
        blocked_now: subscriptionBlocked,
        active_now: access?.active_now === true,
      },
      device_intelligence_registry: {
        status: layers.intelligence_blocked ? 'blocked' : 'active',
        block_reason: layers.intelligence_block_reason || null,
      },
      playback_policy: policy,
    },
    propagation_ok: fullyOpen && !securityDenied,
  }
}
