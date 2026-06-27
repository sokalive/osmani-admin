#!/usr/bin/env node
/**
 * Verify notification images are stored on VPS (never Render disk) + stress prepare-image.
 *
 * Usage:
 *   node scripts/verify-notification-image-storage.mjs
 *   STRESS_COUNT=100 node scripts/verify-notification-image-storage.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/$/, '')
const RENDER = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const TOKEN = String(
  process.env.NOTIFICATION_IMAGE_INGEST_TOKEN ||
    process.env.ADMIN_TOKEN ||
    process.env.ADMIN_API_TOKEN ||
    '3030',
).trim()
const STRESS_COUNT = Math.max(1, Number(process.env.STRESS_COUNT) || 100)

const __dir = path.dirname(fileURLToPath(import.meta.url))
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGf/AP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Cf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Cf//Z',
  'base64',
)

const report = {
  time: new Date().toISOString(),
  stressCount: STRESS_COUNT,
  hosts: {},
  stress: {},
  destinations: {},
  pass: true,
}

function fail(msg) {
  report.pass = false
  console.error(`FAIL ${msg}`)
}

function pass(msg) {
  console.log(`PASS ${msg}`)
}

async function prepareImage(base) {
  const form = new FormData()
  form.append('image', new Blob([TINY_JPEG], { type: 'image/jpeg' }), 'stress-test.jpg')
  const res = await fetch(`${base}/api/notifications/prepare-image`, {
    method: 'POST',
    headers: { 'X-Admin-Token': TOKEN },
    body: form,
  })
  const body = await res.json().catch(() => ({}))
  return { res, body }
}

function assertPushImageUrl(url, label) {
  const u = String(url || '')
  if (!u) {
    fail(`${label}: empty URL`)
    return false
  }
  if (u.includes('onrender.com')) {
    fail(`${label}: still uses Render host: ${u}`)
    return false
  }
  if (!u.startsWith('https://')) {
    fail(`${label}: not HTTPS: ${u}`)
    return false
  }
  if (!u.includes('api.osmanitv.com')) {
    fail(`${label}: push URL must use VPS origin (CDN 404s for notif files): ${u}`)
    return false
  }
  pass(`${label}: ${u.slice(0, 72)}…`)
  return true
}

async function headOk(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' })
    return res.ok
  } catch {
    return false
  }
}

async function probeHost(label, base) {
  report.hosts[label] = { base, prepare: null }
  const health = await fetch(`${base}/api/health`, { cache: 'no-store' })
  if (!health.ok) {
    fail(`${label} health HTTP ${health.status}`)
    return false
  }
  const healthBody = await health.json().catch(() => ({}))
  pass(`${label} health 200 commit=${String(healthBody.commit || '').slice(0, 12)}`)

  const { res, body } = await prepareImage(base)
  report.hosts[label].prepare = { status: res.status, body }
  if (!res.ok || !body?.ok) {
    fail(`${label} prepare-image HTTP ${res.status} ${body?.error || ''}`)
    return false
  }
  pass(`${label} prepare-image storage=${body.storage || 'n/a'} bytes=${body.compressedBytes}`)
  assertPushImageUrl(body.pushImageUrl, `${label} pushImageUrl`)
  if (body.pushImageUrl) {
    const originUrl = body.pushImageUrl.replace('osmanitv.b-cdn.net', 'api.osmanitv.com')
    const ok = (await headOk(body.pushImageUrl)) || (await headOk(originUrl))
    if (ok) pass(`${label} image HEAD 200`)
    else fail(`${label} image HEAD failed for ${body.pushImageUrl}`)
  }
  if (label === 'render' && body.storage !== 'vps-remote') {
    fail(`${label} expected storage=vps-remote got ${body.storage}`)
  }
  if (label === 'vps' && body.storage !== 'vps-local') {
    fail(`${label} expected storage=vps-local got ${body.storage}`)
  }
  return body
}

async function stressPrepare(base) {
  const started = Date.now()
  let ok = 0
  let failed = 0
  const urls = new Set()
  for (let i = 0; i < STRESS_COUNT; i++) {
    const { res, body } = await prepareImage(base)
    if (res.ok && body?.ok && body?.pushImageUrl && !body.pushImageUrl.includes('onrender.com')) {
      ok++
      urls.add(body.pushImageUrl)
    } else {
      failed++
      if (failed <= 3) {
        console.error(`stress error #${failed}:`, res.status, body?.error)
      }
    }
  }
  const ms = Date.now() - started
  report.stress = { ok, failed, uniqueUrls: urls.size, ms }
  if (failed > 0) fail(`stress ${failed}/${STRESS_COUNT} prepare-image failures`)
  else pass(`stress ${ok}/${STRESS_COUNT} prepare-image OK in ${ms}ms (${urls.size} unique URLs)`)
}

async function testDraftDestinations(base, imagePath) {
  const drafts = [
    {
      name: 'home',
      body: {
        title: 'Storage test home',
        message: 'draft',
        status: 'draft',
        image: imagePath,
        destination: { type: 'home' },
      },
    },
    {
      name: 'channel',
      body: {
        title: 'Storage test channel',
        message: 'draft',
        status: 'draft',
        image: imagePath,
        destination: { type: 'channel', channelId: 1 },
      },
    },
    {
      name: 'custom',
      body: {
        title: 'Storage test custom',
        message: 'draft',
        status: 'draft',
        image: imagePath,
        destination: { type: 'custom', deepLink: 'osmani://settings' },
      },
    },
  ]

  for (const d of drafts) {
    const res = await fetch(`${base}/api/notifications`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': TOKEN,
      },
      body: JSON.stringify(d.body),
    })
    const body = await res.json().catch(() => ({}))
    report.destinations[d.name] = { status: res.status, id: body?.id }
    if (!res.ok || !body?.id) {
      fail(`${d.name} draft notification HTTP ${res.status}`)
      continue
    }
    const img = String(body.image || '')
    if (img.includes('onrender.com')) fail(`${d.name} draft image uses Render URL`)
    else pass(`${d.name} draft created id=${body.id}`)
    await fetch(`${base}/api/notifications/${encodeURIComponent(body.id)}`, {
      method: 'DELETE',
      headers: { 'X-Admin-Token': TOKEN },
    }).catch(() => {})
  }
}

async function testHistory(base) {
  const res = await fetch(`${base}/api/notifications`, {
    headers: { 'X-Admin-Token': TOKEN },
    cache: 'no-store',
  })
  const rows = await res.json().catch(() => [])
  if (!res.ok || !Array.isArray(rows)) {
    fail('notification history list failed')
    return
  }
  pass(`notification history ${rows.length} rows`)
  const withImg = rows.filter((r) => r.image)
  const renderRefs = withImg.filter((r) => String(r.image).includes('onrender.com'))
  if (renderRefs.length) {
    fail(`history has ${renderRefs.length} notification images still pointing at Render`)
  } else {
    pass('history images do not reference onrender.com')
  }
}

async function main() {
  console.log('=== Notification image storage verification ===\n')

  const vpsBody = await probeHost('vps', VPS)
  await stressPrepare(VPS)

  try {
    await probeHost('render', RENDER)
  } catch (e) {
    fail(`render probe: ${e?.message || e}`)
  }

  if (vpsBody?.imageForDb) {
    await testDraftDestinations(VPS, vpsBody.imageForDb)
  }
  await testHistory(VPS)

  const outPath = path.join(__dir, '../../tmp-notification-image-verify.json')
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2))
  console.log(`\nReport written to ${outPath}`)
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.pass ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
