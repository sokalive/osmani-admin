/**
 * Production audit: blocked devices by ROOT/EMULATOR signal combinations.
 * Migrate (optional): --execute uses API unblock + smart monitor + playback reconcile.
 *
 * Usage:
 *   node scripts/audit-root-emulator-blocked.mjs
 *   node scripts/audit-root-emulator-blocked.mjs --execute
 */
const API = (process.env.OSMANI_ADMIN_API || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const TOKEN = process.env.ADMIN_TOKEN || '3030'
const EXECUTE = process.argv.includes('--execute')

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Token': TOKEN,
      ...(opts.headers || {}),
    },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${path} ${res.status}: ${body.error || JSON.stringify(body)}`)
  return body
}

function combo(d) {
  const p = []
  if (d.rooted) p.push('ROOT')
  if (d.emulator) p.push('EMULATOR')
  if (d.frida) p.push('FRIDA')
  if (d.tampered_apk) p.push('APK_TAMPER')
  if (d.debugger) p.push('DEBUGGER')
  if (d.clone_detected) p.push('CLONE')
  return p.length ? p.join('+') : 'NONE'
}

function isMigrateEligible(d) {
  if (!d.rooted && !d.emulator) return false
  if (d.frida || d.tampered_apk || d.debugger || d.clone_detected) return false
  return true
}

async function verifyDevice(deviceId) {
  const { verification: v } = await api(`/api/security/devices/${encodeURIComponent(deviceId)}/verification`)
  const sub = await api(`/api/subscription-status?device_id=${encodeURIComponent(deviceId)}`).catch(() => ({}))
  return {
    device_id: deviceId,
    status: v?.status_swahili,
    smart_monitor: v?.smart_monitor_swahili,
    playback: v?.playback_swahili,
    playback_allowed: v?.playback_allowed === true || sub.playbackAllowed === true,
    ok:
      v?.status_swahili === 'Kifaa Kimefunguliwa' &&
      v?.smart_monitor_swahili === 'Imewashwa' &&
      (v?.playback_swahili === 'Inaruhusiwa' || sub.playbackAllowed === true),
  }
}

async function migrateDevice(deviceId) {
  await api(`/api/security/devices/${encodeURIComponent(deviceId)}/action`, {
    method: 'POST',
    body: JSON.stringify({ action: 'unblock_user' }),
  })
  await api(`/api/security/devices/${encodeURIComponent(deviceId)}/action`, {
    method: 'POST',
    body: JSON.stringify({ action: 'enable_smart_monitor' }),
  })
  return verifyDevice(deviceId)
}

async function main() {
  const stats = await api('/api/security/stats')
  const blocked = await api('/api/security/devices?level=blocked&limit=1000')
  const devices = blocked.devices || []

  const byCombo = {}
  const migrate = []
  const keep = []

  for (const d of devices) {
    const c = combo(d)
    byCombo[c] = (byCombo[c] || 0) + 1
    const entry = {
      device_id: d.device_id,
      combo: c,
      admin_status: d.admin_status,
      risk_type: d.risk_type,
      risk_score: d.risk_score,
    }
    if (isMigrateEligible(d)) migrate.push(entry)
    else keep.push({ ...entry, rooted: d.rooted, emulator: d.emulator, frida: d.frida, tampered: d.tampered_apk })
  }

  const report = {
    api: API,
    audited_at: new Date().toISOString(),
    execute: EXECUTE,
    stats,
    total_blocked: devices.length,
    by_combo: byCombo,
    migrate_eligible: migrate.length,
    keep_blocked: keep.length,
    migrate,
    keep,
    migrated: [],
    verification_failures: [],
  }

  if (EXECUTE && migrate.length > 0) {
    for (const item of migrate) {
      try {
        const v = await migrateDevice(item.device_id)
        report.migrated.push(v)
        if (!v.ok) report.verification_failures.push(v)
      } catch (e) {
        report.verification_failures.push({ device_id: item.device_id, error: String(e.message || e) })
      }
    }
    const reconcile = await api('/api/security/reconcile-unblocked-playback', { method: 'POST', body: '{}' })
    report.reconcile = reconcile
  }

  console.log(JSON.stringify(report, null, 2))

  if (EXECUTE && report.verification_failures.length > 0) {
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
