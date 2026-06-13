/**
 * Live verification for Security Center unblock propagation.
 * Usage: node server/scripts/verify-security-unblock-device.mjs [device_id]
 */
const API = process.env.OSMANI_ADMIN_API || 'https://osmani-admin-api.onrender.com'
const TOKEN = process.env.ADMIN_TOKEN || '3030'
const DEVICE_ID = process.argv[2] || '0523d797b3197a0f'

async function j(path, opts = {}) {
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

function check(label, ok, detail = {}) {
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`${mark} ${label}`, Object.keys(detail).length ? detail : '')
  if (!ok) process.exitCode = 1
}

async function main() {
  console.log('API:', API)
  console.log('Device:', DEVICE_ID)

  const health = await j('/api/health')
  check('health ok', health.ok === true, { commit: health.commit })

  const verification = await j(`/api/security/devices/${encodeURIComponent(DEVICE_ID)}/verification`)
  const v = verification.verification
  check('verification payload', !!v, { headline: v?.headline_swahili })

  const sub = await j(`/api/subscription-status?device_id=${encodeURIComponent(DEVICE_ID)}`)
  check('subscription not blocked', sub.blocked !== true, { blocked: sub.blocked })
  check('playback allowed', sub.playbackAllowed === true, {
    playbackGateReason: sub.playbackGateReason,
  })

  if (v) {
    check('Swahili status present', !!v.status_swahili)
    check('propagation ok', v.propagation_ok === true, { layers: v.layers })
    console.log('\n--- Uthibitisho ---')
    console.log('STATUS:', v.status_swahili)
    console.log('Sababu:', v.sababu_swahili)
    console.log('Smart Monitor:', v.smart_monitor_swahili)
    console.log('Playback:', v.playback_swahili)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
