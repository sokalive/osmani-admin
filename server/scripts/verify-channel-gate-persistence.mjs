/**
 * Verify channel update gate persists: settings PUT/GET + update-check v20 parity (VPS + Render).
 * Usage: ADMIN_TOKEN=... node scripts/verify-channel-gate-persistence.mjs
 */
const TOKEN = String(process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '3030').trim()

const HOSTS = [
  { name: 'VPS', api: 'https://api.osmanitv.com' },
  { name: 'Render', api: 'https://osmani-admin-api.onrender.com' },
]

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { cache: 'no-store', ...opts })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

async function adminGet(base, path) {
  return fetchJson(`${base}/api${path}`, {
    headers: {
      'X-Admin-Token': TOKEN,
      'Content-Type': 'application/json',
    },
  })
}

async function adminPut(base, path, payload) {
  return fetchJson(`${base}/api${path}`, {
    method: 'PUT',
    headers: {
      'X-Admin-Token': TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
}

async function probeHost(host) {
  const lines = []
  let ok = true

  const settingsGet = await adminGet(host.api, '/settings/app-update')
  if (settingsGet.status !== 200) {
    lines.push(`FAIL GET settings ${settingsGet.status}`)
    return { ok: false, lines }
  }

  const baseline = settingsGet.body
  const putBody = {
    ...baseline,
    requireUpdateBeforeChannelPlayback: true,
  }
  const putRes = await adminPut(host.api, '/settings/app-update', putBody)
  if (putRes.status !== 200) {
    lines.push(`FAIL PUT settings ${putRes.status}: ${JSON.stringify(putRes.body)}`)
    return { ok: false, lines }
  }
  if (putRes.body.requireUpdateBeforeChannelPlayback !== true) {
    ok = false
    lines.push('FAIL PUT response missing requireUpdateBeforeChannelPlayback:true')
  } else {
    lines.push('OK PUT response requireUpdateBeforeChannelPlayback:true')
  }

  const settingsAfter = await adminGet(host.api, '/settings/app-update')
  if (settingsAfter.body.requireUpdateBeforeChannelPlayback !== true) {
    ok = false
    lines.push(
      `FAIL GET after save: requireUpdateBeforeChannelPlayback=${settingsAfter.body.requireUpdateBeforeChannelPlayback}`,
    )
  } else {
    lines.push('OK GET settings after save: requireUpdateBeforeChannelPlayback:true')
  }

  const uc20 = await fetchJson(`${host.api}/api/update-check?version_code=20`)
  const rt20 = await fetchJson(`${host.api}/api/runtime/app-update?version_code=20`)
  const gateUc = uc20.body?.require_update_before_channel_playback === true
  const gateRt = rt20.body?.require_update_before_channel_playback === true
  if (!gateUc || !gateRt) {
    ok = false
    lines.push(
      `FAIL v20 gate update-check=${uc20.body?.require_update_before_channel_playback} runtime=${rt20.body?.require_update_before_channel_playback}`,
    )
  } else {
    lines.push('OK v20 update-check + runtime/app-update gate active')
  }

  const uc24 = await fetchJson(`${host.api}/api/update-check?version_code=24`)
  if (uc24.body?.require_update_before_channel_playback === true) {
    ok = false
    lines.push('FAIL v24 should not be channel-gated')
  } else {
    lines.push('OK v24 not channel-gated')
  }

  // Restore prior value so we do not leave prod toggled on unless it already was.
  if (baseline.requireUpdateBeforeChannelPlayback !== true) {
    await adminPut(host.api, '/settings/app-update', {
      ...baseline,
      requireUpdateBeforeChannelPlayback: false,
    })
    lines.push('restored baseline requireUpdateBeforeChannelPlayback:false')
  }

  return { ok, lines }
}

let allOk = true
for (const host of HOSTS) {
  console.log(`\n=== ${host.name} (${host.api}) ===`)
  const { ok, lines } = await probeHost(host)
  for (const line of lines) console.log(line)
  if (!ok) allOk = false
}

if (!allOk) {
  console.error('\nChannel gate persistence verification FAILED')
  process.exit(1)
}
console.log('\nChannel gate persistence verification PASSED')
