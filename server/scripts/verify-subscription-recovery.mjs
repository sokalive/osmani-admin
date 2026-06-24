/**
 * Post-recovery validation — sample verify/status on repaired shadow devices.
 *   cd server && node scripts/verify-subscription-recovery.mjs
 */
const RENDER = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/$/, '')
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '3030'
const SAMPLE = Math.max(5, Math.min(50, Number(process.env.SAMPLE_SIZE) || 20))

async function fetchJson(base, path) {
  const res = await fetch(`${base}${path}`, { cache: 'no-store' })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

async function audit(base) {
  const res = await fetch(`${base}/api/runtime/subscription-incident-audit`, {
    headers: { 'X-Admin-Token': ADMIN_TOKEN },
    cache: 'no-store',
  })
  return res.json()
}

async function verifyDevice(base, deviceId) {
  const status = await fetchJson(base, `/api/subscription-status?device_id=${encodeURIComponent(deviceId)}`)
  const verifyRes = await fetch(`${base}/api/subscription/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: deviceId }),
    cache: 'no-store',
  })
  const verify = await verifyRes.json().catch(() => null)
  return {
    device_id: deviceId,
    status_http: status.status,
    status_active: status.body?.active === true,
    status_blocked: status.body?.blocked === true,
    verify_http: verifyRes.status,
    verify_active: verify?.active === true,
    verify_blocked: verify?.blocked === true,
    playback_allowed: verify?.playbackAllowed === true,
  }
}

async function main() {
  const report = { hosts: {}, samples: [], failed: 0 }

  for (const [label, base] of [
    ['VPS', VPS],
    ['Render', RENDER],
  ]) {
    const health = await fetchJson(base, '/api/health')
    const auditBody = await audit(base)
    report.hosts[label] = {
      commit: health.body?.commit,
      health: health.status,
      counts: auditBody.counts,
      after: auditBody.after,
      ok: auditBody.ok === true,
    }
  }

  const shadows = []
  const vpsAudit = report.hosts.VPS?.counts
  if (vpsAudit) {
    const full = await audit(VPS)
    const devices = new Map()
    for (const row of full.before?.revoked_shadow_devices || []) {
      devices.set(row.device_id, row)
    }
    for (const row of full.recovered_users || []) {
      devices.set(row.device_id, row)
    }
    for (const d of devices.keys()) shadows.push(d)
  }

  const pick = [...new Set(shadows)].slice(0, SAMPLE)
  if (pick.length < SAMPLE) {
    const full = await audit(VPS)
    for (const row of full.before?.revoked_shadow_devices || []) {
      if (pick.length >= SAMPLE) break
      if (!pick.includes(row.device_id)) pick.push(row.device_id)
    }
  }

  for (const deviceId of pick.slice(0, SAMPLE)) {
    const vps = await verifyDevice(VPS, deviceId)
    const render = await verifyDevice(RENDER, deviceId)
    const row = { device_id: deviceId, vps, render }
    if (!vps.status_active || !vps.verify_active || vps.status_blocked || vps.verify_blocked) {
      report.failed += 1
    }
    report.samples.push(row)
  }

  console.log(JSON.stringify(report, null, 2))
  const counts = report.hosts.VPS?.counts
  if (
    counts?.total_affected_users > 0 ||
    counts?.incorrectly_revoked_migration_shadow > 0 ||
    counts?.restoration_unresolved > 0 ||
    report.failed > 0
  ) {
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
