/**
 * ycn upstream parity audit — compares header profiles against production proxy paths.
 * Usage: node scripts/audit-ycn-upstream-parity.mjs
 */
import https from 'node:https'
import http from 'node:http'

const API = process.env.API_BASE || 'https://osmani-admin-api.onrender.com'

const EXO_LIB_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) ExoPlayerLib/2.19.1'
const EXO_OKHTTP_UA = 'ExoPlayerLib/2.19.1'
const CHROME_MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'

function fetchWithProfile(url, profile, { maxRedirects = 0, method = 'GET' } = {}) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http
    const headers = { ...profile.headers }
    const opts = { method, timeout: 25_000, headers }
    const req = lib.request(url, opts, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        resolve({
          profile: profile.name,
          status: res.statusCode,
          location: res.headers.location || null,
          contentType: res.headers['content-type'] || '',
          server: res.headers.server || '',
          cfRay: res.headers['cf-ray'] || res.headers['cf-ray'] || '',
          setCookie: res.headers['set-cookie'] ? 'yes' : 'no',
          bodyLen: body.length,
          isM3u8: body.trimStart().startsWith('#EXTM3U'),
          isHtml: body.toLowerCase().includes('<!doctype') || body.toLowerCase().includes('<html'),
          bodyPreview: body.slice(0, 100).replace(/\s+/g, ' '),
          redirectCount: profile._redirectCount || 0,
        })
      })
    })
    req.on('error', (e) => resolve({ profile: profile.name, error: e.message }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ profile: profile.name, error: 'timeout' })
    })
    req.end()
  })
}

async function fetchFollow(url, profile, max = 5) {
  let current = url
  let last = null
  for (let i = 0; i <= max; i++) {
    last = await fetchWithProfile(current, { ...profile, _redirectCount: i })
    if (![301, 302, 307, 308].includes(last.status) || !last.location) {
      last.finalUrl = current
      return last
    }
    current = last.location.startsWith('http') ? last.location : new URL(last.location, current).href
  }
  return { ...last, error: 'too_many_redirects' }
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { timeout: 20_000 }, (res) => {
        let d = ''
        res.on('data', (c) => (d += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(d))
          } catch (e) {
            reject(e)
          }
        })
      })
      .on('error', reject)
  })
}

function buildProfiles(channel) {
  const upstream = channel.url
  const dbReferer = channel.referer || 'https://het140c.ycn-redirect.com'
  const dbOrigin = channel.origin || 'application/vnd.apple.mpegurl'
  const dbUa = channel.userAgent || ''

  return [
    {
      name: 'A_osmani_before_fix',
      headers: {
        'User-Agent': dbUa || CHROME_MOBILE_UA,
        Accept: '*/*',
        Referer: dbReferer,
        Origin: dbOrigin,
      },
    },
    {
      name: 'B_exoplayer_lib_no_origin',
      headers: {
        'User-Agent': EXO_LIB_UA,
        Accept: '*/*',
        Referer: dbReferer,
      },
    },
    {
      name: 'C_exoplayer_lib_exo_accept',
      headers: {
        'User-Agent': EXO_LIB_UA,
        Accept: 'application/vnd.apple.mpegurl,application/x-mpegurl,*/*',
        Referer: dbReferer,
      },
    },
    {
      name: 'D_exoplayer_minimal',
      headers: {
        'User-Agent': EXO_OKHTTP_UA,
        Accept: '*/*',
      },
    },
    {
      name: 'E_exo_origin_from_referer',
      headers: {
        'User-Agent': EXO_LIB_UA,
        Accept: '*/*',
        Referer: dbReferer,
        Origin: 'https://het140c.ycn-redirect.com',
      },
    },
    {
      name: 'F_exo_http_referer_match_upstream',
      headers: {
        'User-Agent': EXO_LIB_UA,
        Accept: '*/*',
        Referer: upstream.replace(/\/[^/]*$/, '/'),
        Origin: 'http://het103b.ycn-redirect.com',
      },
    },
    {
      name: 'G_exo_with_range_manifest',
      headers: {
        'User-Agent': EXO_LIB_UA,
        Accept: '*/*',
        Referer: dbReferer,
        Range: 'bytes=0-',
      },
    },
    {
      name: 'H_chrome_mobile_normalized',
      headers: {
        'User-Agent': CHROME_MOBILE_UA,
        Accept: 'application/vnd.apple.mpegurl,application/x-mpegurl,*/*',
        'Accept-Encoding': 'identity',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: dbReferer,
        Origin: 'https://het140c.ycn-redirect.com',
      },
    },
  ]
}

async function testProductionProxy(channel, label) {
  const playback = label === 'direct' ? channel.playbackUrl : channel.proxy_playback_url
  if (!playback) return { label, error: 'no url' }
  const r = await fetchFollow(playback, {
    name: `PROXY_${label}`,
    headers: { 'User-Agent': 'OsmaniAudit/1.0', Accept: '*/*' },
  })
  return { label, playback: playback.slice(0, 120), ...r }
}

async function main() {
  const health = await getJson(`${API}/api/health`)
  const channels = await getJson(`${API}/api/channels`)
  const ycn = channels.filter((c) => /ycn-redirect/i.test(c.url || ''))
  const ch = ycn.find((c) => c.id === 16) || ycn[0]
  if (!ch) {
    console.error('No ycn channel found')
    process.exit(1)
  }

  console.log(
    JSON.stringify(
      {
        audit_at: new Date().toISOString(),
        deploy_commit: health.commit,
        channel: {
          id: ch.id,
          name: ch.name,
          url: ch.url,
          referer: ch.referer,
          origin: ch.origin,
          userAgent: ch.userAgent,
        },
        note: 'Direct upstream tests run from this machine (not Render). Production proxy tests hit Render egress IP.',
      },
      null,
      2,
    ),
  )

  console.log('\n=== 1) DIRECT UPSTREAM (audit runner IP) ===')
  const profiles = buildProfiles(ch)
  for (const p of profiles) {
    const r = await fetchFollow(ch.url, p)
    console.log(JSON.stringify(r))
    await new Promise((x) => setTimeout(x, 300))
  }

  console.log('\n=== 2) PRODUCTION stream-direct ===')
  console.log(JSON.stringify(await testProductionProxy(ch, 'direct')))

  console.log('\n=== 3) PRODUCTION stream-proxy ===')
  console.log(JSON.stringify(await testProductionProxy(ch, 'proxy')))

  console.log('\n=== 4) HTTP vs HTTPS upstream host ===')
  try {
    const u = new URL(ch.url)
    const httpsUrl = ch.url.replace(/^http:/, 'https:')
    console.log(
      JSON.stringify({
        http: await fetchFollow(ch.url, { name: 'https_check_http', headers: { 'User-Agent': EXO_LIB_UA, Referer: ch.referer } }),
        https: await fetchFollow(httpsUrl, { name: 'https_check_https', headers: { 'User-Agent': EXO_LIB_UA, Referer: ch.referer } }),
      }),
    )
  } catch (e) {
    console.log(JSON.stringify({ error: String(e.message) }))
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
