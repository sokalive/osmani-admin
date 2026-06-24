#!/usr/bin/env node
/**
 * Smoke verification for account-update, VIDEO channel, transfer/search fixes.
 * Usage: node server/scripts/verify-admin-features.mjs [--base http://144.91.117.90/api]
 */
const base = (() => {
  const i = process.argv.indexOf('--base')
  if (i >= 0 && process.argv[i + 1]) return String(process.argv[i + 1]).replace(/\/$/, '')
  return String(process.env.OSMANI_API_BASE || 'http://144.91.117.90/api').replace(/\/$/, '')
})()

const adminToken = String(process.env.ADMIN_API_TOKEN || process.env.APP_UPDATE_ADMIN_TOKEN || '').trim()

async function get(path, headers = {}) {
  const res = await fetch(`${base}${path}`, { headers: { ...headers } })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

function ok(label, cond, detail = '') {
  const pass = Boolean(cond)
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  return pass
}

async function main() {
  console.log('API base:', base)
  const results = []

  const account = await get('/runtime/account-update?version_code=20')
  results.push(ok('account-update 200', account.status === 200 && account.body?.ok))
  results.push(ok('account-update latest version', Number(account.body?.latest_version_code) > 0))
  results.push(ok('account-update installed', account.body?.installed_version_code === 20))

  const account24 = await get('/runtime/account-update?version_code=24')
  results.push(ok('account-update v24 targeting', account24.body?.targeting_v24_plus === true))

  const chV20 = await get('/channels?version_code=20')
  const video20 = Array.isArray(chV20.body)
    ? chV20.body.find((c) => String(c.name).toUpperCase() === 'VIDEO')
    : null
  results.push(ok('VIDEO channel listed v20', Boolean(video20)))
  results.push(ok('VIDEO instruction flags v20', video20?.instruction_video === true))
  results.push(ok('VIDEO free v20', video20?.accessType === 'free' || video20?.access_premium === false))

  const chV24 = await get('/channels?version_code=24')
  const video24 = Array.isArray(chV24.body)
    ? chV24.body.find((c) => String(c.name).toUpperCase() === 'VIDEO')
    : null
  results.push(
    ok(
      'VIDEO hidden from v24 when hide_v24_plus',
      !video24 || video24.show_in_app === false,
      video24 ? `show_in_app=${video24.show_in_app}` : 'not in list',
    ),
  )

  if (adminToken && video20?.id) {
    const del = await fetch(`${base}/channels/${video20.id}`, {
      method: 'DELETE',
      headers: { 'x-admin-token': adminToken },
    })
    results.push(ok('VIDEO not deletable', del.status === 403))
  } else {
    console.log('SKIP VIDEO delete test (no ADMIN_API_TOKEN or VIDEO row)')
  }

  const cutover = await get('/runtime/cutover-status')
  results.push(ok('cutover commit present', Boolean(cutover.body?.commit)))

  const passed = results.filter(Boolean).length
  const total = results.length
  console.log(`\n${passed}/${total} checks passed`)
  process.exit(passed === total ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
