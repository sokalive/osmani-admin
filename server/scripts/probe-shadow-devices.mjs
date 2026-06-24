/**
 * Probe all shadow devices from incident audit for real subscription access.
 */
const API = String(process.env.API_BASE || 'https://api.osmanitv.com').replace(/\/$/, '')
const TOKEN = process.env.ADMIN_TOKEN || '3030'

async function audit() {
  const res = await fetch(`${API}/api/runtime/subscription-incident-audit`, {
    headers: { 'X-Admin-Token': TOKEN },
    cache: 'no-store',
  })
  return res.json()
}

async function status(deviceId) {
  const res = await fetch(`${API}/api/subscription-status?device_id=${encodeURIComponent(deviceId)}`, {
    cache: 'no-store',
  })
  const body = await res.json().catch(() => ({}))
  return { http: res.status, active: body.active === true, blocked: body.blocked === true, playback: body.playbackAllowed === true }
}

const full = await audit()
const devices = [...new Set((full.after?.revoked_shadow_devices || full.before?.revoked_shadow_devices || []).map((r) => r.device_id))]
const results = []
let inactive = 0
let active = 0
for (const d of devices) {
  const s = await status(d)
  if (s.active) active++
  else inactive++
  results.push({ device_id: d, ...s })
}
console.log(JSON.stringify({ total: devices.length, active, inactive, results }, null, 2))
process.exit(inactive > 0 ? 1 : 0)
