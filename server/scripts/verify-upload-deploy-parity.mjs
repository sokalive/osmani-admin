/**
 * Verify VPS + Render API parity after upload/instruction-video deploy.
 *
 * Usage:
 *   node scripts/verify-upload-deploy-parity.mjs
 */
const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/$/, '')
const RENDER = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')

const CHECKS = [
  { name: 'health', path: '/api/health' },
  { name: 'server-health', path: '/api/server-health' },
  { name: 'account-update', path: '/api/runtime/account-update?version_code=20' },
  { name: 'channels', path: '/api/channels' },
]

async function fetchJson(base, path) {
  const url = `${base}${path}`
  const res = await fetch(url, { cache: 'no-store' })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { _raw: text.slice(0, 200) }
  }
  return { url, status: res.status, body, ok: res.ok }
}

function findVideoChannel(channels) {
  if (!Array.isArray(channels)) return null
  return (
    channels.find((c) => String(c?.channel_kind || c?.channelKind || '').toLowerCase() === 'instruction_video') ||
    channels.find((c) => String(c?.name || '').toUpperCase() === 'VIDEO') ||
    null
  )
}

const report = { time: new Date().toISOString(), hosts: {}, parity: {} }

for (const host of [
  { key: 'vps', base: VPS },
  { key: 'render', base: RENDER },
]) {
  report.hosts[host.key] = { base: host.base, checks: {} }
  for (const check of CHECKS) {
    try {
      const out = await fetchJson(host.base, check.path)
      report.hosts[host.key].checks[check.name] = {
        status: out.status,
        ok: out.ok,
        commit: out.body?.commit ? String(out.body.commit).slice(0, 12) : null,
        sample: check.name === 'channels' ? findVideoChannel(out.body) : undefined,
        body: check.name === 'account-update' ? out.body : undefined,
      }
    } catch (e) {
      report.hosts[host.key].checks[check.name] = {
        status: 0,
        ok: false,
        error: String(e?.message || e),
      }
    }
  }
}

const vpsCommit = report.hosts.vps.checks.health?.commit
const renderCommit = report.hosts.render.checks.health?.commit
report.parity.commit_match = Boolean(vpsCommit && renderCommit && vpsCommit === renderCommit)
report.parity.vps_commit = vpsCommit
report.parity.render_commit = renderCommit

const vpsVideo = report.hosts.vps.checks.channels?.sample
const renderVideo = report.hosts.render.checks.channels?.sample
report.parity.video_channel = {
  vps: vpsVideo ? { id: vpsVideo.id, name: vpsVideo.name, channel_kind: vpsVideo.channel_kind || vpsVideo.channelKind } : null,
  render: renderVideo ? { id: renderVideo.id, name: renderVideo.name, channel_kind: renderVideo.channel_kind || renderVideo.channelKind } : null,
}

let pass = true
for (const hostKey of ['vps', 'render']) {
  for (const [name, row] of Object.entries(report.hosts[hostKey].checks)) {
    if (!row.ok) {
      pass = false
      console.error(`FAIL ${hostKey} ${name}: HTTP ${row.status} ${row.error || ''}`)
    } else {
      console.log(`PASS ${hostKey} ${name}: HTTP ${row.status} commit=${row.commit || 'n/a'}`)
    }
  }
}

if (!report.parity.commit_match) {
  pass = false
  console.error(`FAIL commit parity: VPS=${vpsCommit} Render=${renderCommit}`)
} else {
  console.log(`PASS commit parity: ${vpsCommit}`)
}

console.log(JSON.stringify(report, null, 2))
process.exit(pass ? 0 : 1)
