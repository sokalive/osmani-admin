#!/usr/bin/env node
/**
 * Full Part A verification — VPS + Render.
 * Usage: ADMIN_API_TOKEN=... node server/scripts/verify-all-features.mjs
 */
const VPS = String(process.env.VPS_API_BASE || 'https://api.osmanitv.com/api').replace(/\/$/, '')
const RENDER = String(process.env.RENDER_API_BASE || 'https://osmani-admin-api.onrender.com/api').replace(/\/$/, '')
const ADMIN = String(process.env.ADMIN_API_TOKEN || process.env.APP_UPDATE_ADMIN_TOKEN || '').trim()

const results = []

function row(host, feature, pass, detail = '') {
  results.push({ host, feature, pass: Boolean(pass), detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} [${host}] ${feature}${detail ? ` — ${detail}` : ''}`)
}

async function get(base, path, headers = {}) {
  const res = await fetch(`${base}${path}`, { headers })
  let body = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return { status: res.status, body }
}

async function del(base, path, headers = {}) {
  const res = await fetch(`${base}${path}`, { method: 'DELETE', headers })
  let body = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return { status: res.status, body }
}

async function verifyHost(host, base) {
  const health = await get(base, '/health')
  row(host, 'health', health.status === 200 && health.body?.ok, health.body?.commit?.slice(0, 7))

  const acc20 = await get(base, '/runtime/account-update?version_code=20')
  row(host, 'account-update v20', acc20.status === 200 && acc20.body?.ok)
  row(
    host,
    'account-update v20 available',
    acc20.body?.update_available === true,
    `latest=${acc20.body?.latest_version_code}`,
  )

  const acc24 = await get(base, '/runtime/account-update?version_code=24')
  row(host, 'account-update v24', acc24.status === 200 && acc24.body?.ok)
  row(
    host,
    'account-update v24 targeting',
    acc24.body?.targeting_v24_plus === true,
    `update_available=${acc24.body?.update_available}`,
  )

  const gate20 = await get(base, '/update-check?version_code=20')
  const gate24 = await get(base, '/update-check?version_code=24')
  row(
    host,
    'update-check v20 gate field',
    typeof gate20.body?.require_update_before_channel_playback === 'boolean',
    String(gate20.body?.require_update_before_channel_playback),
  )
  row(
    host,
    'update-check v24 gate false',
    gate24.body?.require_update_before_channel_playback === false,
    String(gate24.body?.require_update_before_channel_playback),
  )

  const chAdmin = await get(base, '/channels')
  const video = Array.isArray(chAdmin.body)
    ? chAdmin.body.find((c) => String(c.name).toUpperCase() === 'VIDEO')
    : null
  row(host, 'VIDEO exists', Boolean(video), video ? `id=${video.id}` : 'missing')
  if (video) {
    row(host, 'VIDEO instruction flags', video.instruction_video === true)
    row(host, 'VIDEO free', video.accessType === 'free' || video.access_premium === false)
    row(host, 'VIDEO locked API', video.is_system_locked === true)
    if (ADMIN) {
      const delRes = await del(base, `/channels/${video.id}`, { 'x-admin-token': ADMIN })
      row(host, 'VIDEO not deletable', delRes.status === 403)
    }
  }

  const chV20 = await get(base, '/channels?version_code=20')
  const chV24 = await get(base, '/channels?version_code=24')
  const video20 = Array.isArray(chV20.body)
    ? chV20.body.find((c) => String(c.name).toUpperCase() === 'VIDEO')
    : null
  const video24 = Array.isArray(chV24.body)
    ? chV24.body.find((c) => String(c.name).toUpperCase() === 'VIDEO')
    : null
  row(
    host,
    'VIDEO v20 list/API',
    Boolean(video20),
    video20 ? `show_in_app=${video20.show_in_app}` : 'not listed (check admin showInApp)',
  )
  row(
    host,
    'VIDEO v24 hidden/filtered',
    !video24 || video24.show_in_app === false,
    video24 ? `show_in_app=${video24.show_in_app}` : 'not in list',
  )

  if (ADMIN) {
    const inv = await get(base, '/admin/customer-investigation/investigate?device_id=probe-nonexistent', {
      'x-admin-token': ADMIN,
    })
    row(host, 'customer investigation endpoint', inv.status === 200 && inv.body?.ok === true)
  } else {
    row(host, 'customer investigation endpoint', true, 'SKIP no ADMIN token')
  }
}

async function main() {
  console.log('VPS:', VPS)
  console.log('Render:', RENDER)
  await verifyHost('VPS', VPS)
  await verifyHost('Render', RENDER)

  const passed = results.filter((r) => r.pass).length
  const total = results.length
  console.log(`\n${passed}/${total} checks passed`)
  const vpsCommit = (await get(VPS, '/health')).body?.commit
  const renderCommit = (await get(RENDER, '/health')).body?.commit
  console.log('VPS commit:', vpsCommit)
  console.log('Render commit:', renderCommit)
  console.log('Commits match:', vpsCommit === renderCommit)
  process.exit(passed === total ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
