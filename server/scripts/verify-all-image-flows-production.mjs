#!/usr/bin/env node
/**
 * Individual production image-flow verification (no shared-pipeline assumptions).
 *
 *   node server/scripts/verify-all-image-flows-production.mjs
 */
const API = String(process.env.API || 'https://api.osmanitv.com').replace(/\/$/, '')
const TOKEN = String(process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '3030').trim()
const AZAM_CHANNEL_ID = Number(process.env.AZAM_CHANNEL_ID || 18)

/** 1x1 PNG */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const results = []

function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`)
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { cache: 'no-store', ...opts })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { raw: text.slice(0, 500) }
  }
  return { res, body }
}

async function headUrl(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(15_000) })
    return res.status
  } catch (e) {
    return `ERR:${e?.message || e}`
  }
}

async function testPublicImage(label, url) {
  const status = await headUrl(url)
  record(`${label} HEAD`, status === 200, `${url} → ${status}`)
  return status === 200
}

async function putChannelThumbnail(channelId) {
  const list = await fetchJson(`${API}/api/channels`)
  const before = Array.isArray(list.body) ? list.body.find((c) => Number(c.id) === channelId) : null
  if (!before) {
    record('channel GET before PUT', false, `channel ${channelId} not in list`)
    return null
  }
  const fd = new FormData()
  fd.append('name', before.name || 'Test')
  fd.append('url', before.url || before.streamUrl || '')
  fd.append('category', before.category || 'Home')
  fd.append('bottomTab', before.bottomTab || before.bottomTabsDisplay || 'Home')
  fd.append('accessType', before.accessType || 'free')
  fd.append('isLive', String(before.isLive ?? before.live ?? true))
  fd.append('isHD', String(before.isHD ?? before.hd ?? false))
  fd.append('isActive', String(before.isActive ?? before.active ?? true))
  fd.append('showInApp', String(before.showInApp ?? before.show_in_app ?? true))
  fd.append('playerType', before.playerType || before.player_type || 'webview')
  fd.append('thumbnail', new Blob([TINY_PNG], { type: 'image/png' }), 'verify-channel.png')

  const putRes = await fetchJson(`${API}/api/channels/${channelId}`, {
    method: 'PUT',
    headers: { 'x-admin-token': TOKEN },
    body: fd,
  })
  record(
    'channel thumbnail UPDATE',
    putRes.res.ok && putRes.body?.thumbnail,
    `HTTP ${putRes.res.status} thumb=${putRes.body?.thumbnail || putRes.body?.error || ''}`,
  )
  if (!putRes.res.ok) return null
  const thumb = putRes.body.thumbnail || putRes.body.thumbnailUrl
  await testPublicImage('channel thumbnail UPDATE public', thumb)
  return { before, after: putRes.body, thumb }
}

async function testBannerFlow() {
  const list = await fetchJson(`${API}/api/banners/manage`, { headers: { 'x-admin-token': TOKEN } })
  if (!list.res.ok || !Array.isArray(list.body) || list.body.length === 0) {
    record('banner UPDATE', false, 'no banners to test')
    return
  }
  const banner = list.body[0]
  const fd = new FormData()
  fd.append('title', banner.title || 'Verify')
  fd.append('active', String(banner.active ?? true))
  fd.append('enabled', String(banner.enabled ?? true))
  fd.append('image', new Blob([TINY_PNG], { type: 'image/png' }), 'verify-banner.png')
  const putRes = await fetchJson(`${API}/api/banners/${banner.id}`, {
    method: 'PUT',
    headers: { 'x-admin-token': TOKEN },
    body: fd,
  })
  const img = putRes.body?.image || putRes.body?.imageUrl
  record('banner UPDATE', putRes.res.ok && img, `HTTP ${putRes.res.status} image=${img || putRes.body?.error}`)
  if (img) await testPublicImage('banner UPDATE public', img.startsWith('http') ? img : `${API}${img}`)
}

async function testNotificationImage() {
  const form = new FormData()
  form.append('image', new Blob([TINY_PNG], { type: 'image/png' }), 'verify-notif.png')
  const prep = await fetchJson(`${API}/api/notifications/prepare-image`, {
    method: 'POST',
    headers: { 'x-admin-token': TOKEN },
    body: form,
  })
  const path = prep.body?.imageForDb || prep.body?.image
  record('notification prepare-image', prep.res.ok && path, `HTTP ${prep.res.status} ${path || prep.body?.error}`)
  if (path) {
    const url = prep.body.pushImageUrl || `${API}${path}`
    await testPublicImage('notification public', url)
  }
}

async function testPaymentLogo() {
  const list = await fetchJson(`${API}/api/settings/payment-providers`, {
    headers: { 'x-admin-token': TOKEN },
  })
  if (!list.res.ok || !Array.isArray(list.body) || list.body.length === 0) {
    record('payment logo UPDATE', false, 'no providers')
    return
  }
  const p = list.body[0]
  const fd = new FormData()
  fd.append('name', p.name || 'Verify')
  fd.append('active', String(p.active ?? true))
  fd.append('logo', new Blob([TINY_PNG], { type: 'image/png' }), 'verify-logo.png')
  const putRes = await fetchJson(`${API}/api/settings/payment-providers/${p.id}`, {
    method: 'PUT',
    headers: { 'x-admin-token': TOKEN },
    body: fd,
  })
  const logo = putRes.body?.logoUrl || putRes.body?.logo
  record('payment logo UPDATE', putRes.res.ok && logo, `HTTP ${putRes.res.status} logo=${logo || putRes.body?.error}`)
  if (logo) await testPublicImage('payment logo public', logo)
}

async function main() {
  console.log('=== All image flows production verification ===\n')
  console.log(`API: ${API}\n`)

  const cutover = await fetchJson(`${API}/api/runtime/cutover-status`)
  record('VPS cutover-status', cutover.res.ok, `commit=${String(cutover.body?.commit || '').slice(0, 12)} disk=${cutover.body?.uploads_disk?.used_percent}%`)

  const channels = await fetchJson(`${API}/api/channels`)
  const azam = Array.isArray(channels.body)
    ? channels.body.find((c) => Number(c.id) === AZAM_CHANNEL_ID || /azam\s*3/i.test(c.name || ''))
    : null
  if (azam) {
    record(
      'Azam 3 HD API payload',
      Boolean(azam.thumbnail || azam.thumbnailUrl),
      `id=${azam.id} thumb=${azam.thumbnail || azam.thumbnailUrl || 'MISSING'}`,
    )
    if (azam.thumbnail || azam.thumbnailUrl) {
      await testPublicImage('Azam 3 HD current', azam.thumbnail || azam.thumbnailUrl)
    }
  } else {
    record('Azam 3 HD lookup', false, `channel ${AZAM_CHANNEL_ID} not found`)
  }

  await putChannelThumbnail(AZAM_CHANNEL_ID)
  await testBannerFlow()
  await testNotificationImage()
  await testPaymentLogo()

  const failed = results.filter((r) => !r.ok)
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
