#!/usr/bin/env node
/**
 * Production admin parity investigation — VPS vs Render vs GitHub.
 */
const VPS_ADMIN = 'https://admin.osmanitv.com'
const RENDER_ADMIN = 'https://osmani-admin-mpya.onrender.com'
const VPS_API = 'https://api.osmanitv.com'
const RENDER_API = 'https://osmani-admin-api.onrender.com'
const GITHUB = 'https://api.github.com/repos/sokalive/osmani-admin/commits/main'

const MARKERS = [
  'Muhtasari',
  'Wasifu wa mtumiaji',
  'Inatumika',
  'Zuia Mtumiaji',
  'Historia ya Malipo',
  'Mstari wa Matukio',
  'Hatua za Msimamizi',
  'Kifaa cha Sasa',
  ',1500)',
]

async function fetchText(url, opts = {}) {
  const t0 = performance.now()
  const res = await fetch(url, { ...opts, cache: 'no-store' })
  const ms = Math.round(performance.now() - t0)
  const text = await res.text()
  return { res, text, ms }
}

async function fetchJson(url) {
  const { res, text } = await fetchText(url, { headers: { Accept: 'application/json' } })
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { res, json, text }
}

async function adminBundle(adminUrl) {
  const home = await fetchText(adminUrl + '/')
  const html = home.text
  const jsMatch = html.match(/src="(\/assets\/index-[^"]+\.js)"/)
  const cssMatch = html.match(/href="(\/assets\/index-[^"]+\.css)"/)
  if (!jsMatch) return { error: 'no js bundle in index.html', htmlLen: html.length }

  const jsUrl = adminUrl + jsMatch[1]
  const cssUrl = cssMatch ? adminUrl + cssMatch[1] : null
  const [js, css] = await Promise.all([
    fetchText(jsUrl),
    cssUrl ? fetchText(cssUrl) : Promise.resolve(null),
  ])

  const jsBody = js.text
  const cssBody = css?.text || ''

  async function hash(str) {
    const buf = new TextEncoder().encode(str)
    const digest = await crypto.subtle.digest('SHA-256', buf)
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
  }

  const jsHash = await hash(jsBody)
  const cssHash = cssBody ? await hash(cssBody) : null

  const markers = Object.fromEntries(MARKERS.map((m) => [m, jsBody.includes(m)]))

  // Vite build timestamp sometimes embedded
  const buildHint = jsBody.match(/buildTime["']?\s*[:=]\s*["']([^"']+)["']/)?.[1] || null

  return {
    adminUrl,
    indexMs: home.ms,
    jsBundle: jsMatch[1],
    cssBundle: cssMatch?.[1] || null,
    jsBytes: jsBody.length,
    cssBytes: cssBody.length,
    jsHash,
    cssHash,
    jsFetchMs: js.ms,
    cacheControlJs: js.res.headers.get('cache-control'),
    cacheControlHtml: home.res.headers.get('cache-control'),
    etagJs: js.res.headers.get('etag'),
    lastModifiedJs: js.res.headers.get('last-modified'),
    buildHint,
    markers,
    markersPass: MARKERS.filter((m) => jsBody.includes(m)).length,
    markersTotal: MARKERS.length,
  }
}

async function main() {
  console.log('=== ADMIN PRODUCTION PARITY INVESTIGATION ===')
  console.log('Time:', new Date().toISOString(), '\n')

  let githubCommit = null
  try {
    const gh = await fetchJson(GITHUB)
    githubCommit = gh.json?.sha || null
    console.log('GitHub main:', githubCommit?.slice(0, 7), githubCommit || 'unknown')
  } catch (e) {
    console.log('GitHub main: fetch failed', e.message)
  }

  const [vpsApi, renderApi, vpsAdmin, renderAdmin] = await Promise.all([
    fetchJson(`${VPS_API}/api/health`),
    fetchJson(`${RENDER_API}/api/health`),
    adminBundle(VPS_ADMIN),
    adminBundle(RENDER_ADMIN),
  ])

  console.log('\n--- API commits ---')
  console.log('VPS API:', vpsApi.json?.commit?.slice(0, 7), vpsApi.json?.commit)
  console.log('Render API:', renderApi.json?.commit?.slice(0, 7), renderApi.json?.commit)

  console.log('\n--- Admin bundles ---')
  console.log(JSON.stringify({ vps: vpsAdmin, render: renderAdmin }, null, 2))

  const identical =
    vpsAdmin.jsBundle === renderAdmin.jsBundle &&
    vpsAdmin.jsHash === renderAdmin.jsHash &&
    vpsAdmin.cssBundle === renderAdmin.cssBundle &&
    vpsAdmin.cssHash === renderAdmin.cssHash

  console.log('\n--- Parity summary ---')
  console.log('Same JS bundle path:', vpsAdmin.jsBundle === renderAdmin.jsBundle, vpsAdmin.jsBundle, renderAdmin.jsBundle)
  console.log('Same JS content hash:', vpsAdmin.jsHash === renderAdmin.jsHash, vpsAdmin.jsHash, renderAdmin.jsHash)
  console.log('Same CSS bundle path:', vpsAdmin.cssBundle === renderAdmin.cssBundle)
  console.log('Same CSS content hash:', vpsAdmin.cssHash === renderAdmin.cssHash)
  console.log('Marker parity:', vpsAdmin.markersPass, 'vs', renderAdmin.markersPass, '/', MARKERS.length)
  console.log('100% identical assets:', identical && vpsAdmin.markersPass === renderAdmin.markersPass)

  if (!identical || vpsAdmin.markersPass !== renderAdmin.markersPass) {
    console.log('\nMarker diff:')
    for (const m of MARKERS) {
      if (vpsAdmin.markers?.[m] !== renderAdmin.markers?.[m]) {
        console.log(`  ${m}: VPS=${vpsAdmin.markers?.[m]} Render=${renderAdmin.markers?.[m]}`)
      }
    }
  }

  process.exit(identical && vpsAdmin.markersPass === MARKERS.length && renderAdmin.markersPass === MARKERS.length ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
