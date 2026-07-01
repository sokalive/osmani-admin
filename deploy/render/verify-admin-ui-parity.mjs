#!/usr/bin/env node
/**
 * Final admin UI parity gate — VPS vs Render must match commit, CSS, UI markers, and normalized JS.
 * Usage: EXPECT_COMMIT=7dc0a84 node deploy/render/verify-admin-ui-parity.mjs
 */
const EXPECT = String(process.env.EXPECT_COMMIT || '7dc0a84').trim()
const VPS_ADMIN = 'https://admin.osmanitv.com'
const RENDER_ADMIN = 'https://osmani-admin-mpya.onrender.com'
const VPS_API = 'https://api.osmanitv.com'
const RENDER_API = 'https://osmani-admin-api.onrender.com'
const TOKEN = process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '3030'
const headers = { 'X-Admin-Token': TOKEN, 'Cache-Control': 'no-cache' }

const UI_MARKERS = [
  'Muhtasari',
  'Usajili',
  'Malipo',
  'Matumizi',
  'Vifaa',
  'Historia',
  'Wasifu wa mtumiaji',
  'Inatumika',
  'Zuia Mtumiaji',
  'Historia ya Malipo',
  'Mstari wa Matukio',
  'Hatua za Msimamizi',
  'Kifaa cha Sasa',
  ',1500)',
]

const report = { pass: [], fail: [] }

function pass(name, detail) {
  report.pass.push({ name, detail })
  console.log(`PASS ${name}: ${detail}`)
}

function fail(name, detail) {
  report.fail.push({ name, detail })
  console.error(`FAIL ${name}: ${detail}`)
}

async function fetchJson(url) {
  const res = await fetch(url, { headers, cache: 'no-store' })
  return { res, body: await res.json().catch(() => null) }
}

async function adminAssets(adminUrl) {
  const html = await fetch(`${adminUrl}/`, { cache: 'no-store' }).then((r) => r.text())
  const jsPath = html.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1]
  const cssPath = html.match(/href="(\/assets\/index-[^"]+\.css)"/)?.[1]
  if (!jsPath) throw new Error(`${adminUrl} no js bundle`)
  const [js, css] = await Promise.all([
    fetch(`${adminUrl}${jsPath}`, { cache: 'no-store' }).then((r) => r.text()),
    cssPath ? fetch(`${adminUrl}${cssPath}`, { cache: 'no-store' }).then((r) => r.text()) : Promise.resolve(''),
  ])
  async function hash(str) {
    const buf = new TextEncoder().encode(str)
    const digest = await crypto.subtle.digest('SHA-256', buf)
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  }
  const normalizedJs = js
    .replace(/https:\/\/osmani-admin-api\.onrender\.com/g, '__API__')
    .replace(/var \w+=``/g, '__API__')
  return {
    jsPath,
    cssPath,
    jsLen: js.length,
    cssLen: css.length,
    jsHash: await hash(js),
    cssHash: css ? await hash(css) : null,
    normalizedJsHash: await hash(normalizedJs),
    markers: Object.fromEntries(UI_MARKERS.map((m) => [m, js.includes(m)])),
  }
}

async function main() {
  console.log('=== ADMIN UI PARITY VERIFICATION ===')
  console.log('Expected commit:', EXPECT)
  console.log('Time:', new Date().toISOString(), '\n')

  const [vpsApi, renderApi] = await Promise.all([
    fetchJson(`${VPS_API}/api/runtime/cutover-status`),
    fetchJson(`${RENDER_API}/api/runtime/cutover-status`),
  ])
  const vpsCommit = String(vpsApi.body?.commit || '')
  const renderCommit = String(renderApi.body?.commit || '')

  if (vpsCommit.startsWith(EXPECT)) pass('vps-api-commit', vpsCommit.slice(0, 12))
  else fail('vps-api-commit', `${vpsCommit.slice(0, 12)} expected ${EXPECT}`)

  if (renderCommit.startsWith(EXPECT)) pass('render-api-commit', renderCommit.slice(0, 12))
  else fail('render-api-commit', `${renderCommit.slice(0, 12)} expected ${EXPECT}`)

  const [vps, render] = await Promise.all([adminAssets(VPS_ADMIN), adminAssets(RENDER_ADMIN)])

  pass('vps-js-bundle', vps.jsPath)
  pass('render-js-bundle', render.jsPath)

  if (vps.jsPath === render.jsPath) pass('js-bundle-filename', vps.jsPath)
  else fail('js-bundle-filename', `VPS ${vps.jsPath} ≠ Render ${render.jsPath}`)

  if (vps.jsHash === render.jsHash) pass('js-content-hash', vps.jsHash.slice(0, 16))
  else fail('js-content-hash', `VPS ${vps.jsHash.slice(0, 16)} ≠ Render ${render.jsHash.slice(0, 16)}`)

  if (vps.cssPath === render.cssPath && vps.cssHash === render.cssHash) {
    pass('css-parity', `${vps.cssPath} ${vps.cssHash.slice(0, 16)}`)
  } else {
    fail('css-parity', `VPS ${vps.cssPath} Render ${render.cssPath}`)
  }

  if (vps.normalizedJsHash === render.normalizedJsHash) {
    pass('js-normalized-parity', vps.normalizedJsHash.slice(0, 16))
  } else {
    fail('js-normalized-parity', 'API URL normalization still differs')
  }

  for (const m of UI_MARKERS) {
    if (vps.markers[m] && render.markers[m]) pass(`ui-marker-${m}`, 'both')
    else fail(`ui-marker-${m}`, `VPS=${vps.markers[m]} Render=${render.markers[m]}`)
  }

  // Functional: 20 users + investigate
  const usersRes = await fetchJson(`${VPS_API}/api/users/active?page=1&limit=20`)
  const items = usersRes.body?.items || []
  if (items.length >= 10) pass('users-sample', `${items.length} active users fetched`)
  else fail('users-sample', `only ${items.length} users`)

  let investigateOk = 0
  for (const u of items.slice(0, 20)) {
    const q = new URLSearchParams({ device_id: u.device_id })
    const inv = await fetch(`${VPS_API}/api/admin/customer-investigation/investigate?${q}`, { headers, cache: 'no-store' })
    if (inv.ok) investigateOk++
  }
  if (investigateOk >= Math.min(20, items.length)) pass('drawer-data-20', `${investigateOk} investigate OK`)
  else fail('drawer-data-20', `${investigateOk}/${items.length}`)

  console.log('\n=== SUMMARY ===')
  console.log(JSON.stringify({ passed: report.pass.length, failed: report.fail.length }, null, 2))

  if (report.fail.length) {
    console.error('\nRESULT: FAIL')
    process.exit(1)
  }
  console.log('\nRESULT: PASS — VPS Admin and Render Admin UI parity verified')
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
