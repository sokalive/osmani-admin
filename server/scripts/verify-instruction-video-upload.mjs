#!/usr/bin/env node
/**
 * Verify instruction VIDEO channel upload pipeline (VPS storage, metadata, playback URL).
 *
 * Usage:
 *   node scripts/verify-instruction-video-upload.mjs
 *   LARGE_MB=5 node scripts/verify-instruction-video-upload.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/$/, '')
const RENDER = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const TOKEN = String(
  process.env.INSTRUCTION_VIDEO_INGEST_TOKEN ||
    process.env.NOTIFICATION_IMAGE_INGEST_TOKEN ||
    process.env.ADMIN_TOKEN ||
    process.env.ADMIN_API_TOKEN ||
    '3030',
).trim()
const CHANNEL_ID = Number(process.env.INSTRUCTION_VIDEO_CHANNEL_ID || 19)
const LARGE_MB = Math.max(0, Number(process.env.LARGE_MB) || 2)

const __dir = path.dirname(fileURLToPath(import.meta.url))

/** Minimal valid MP4 (ftyp + mdat) — enough for upload + storage tests. */
function tinyMp4Buffer() {
  const ftyp = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32, 0x6d, 0x70, 0x34, 0x31,
  ])
  const mdat = Buffer.alloc(64, 0)
  mdat.writeUInt32BE(64, 0)
  mdat.write('mdat', 4)
  return Buffer.concat([ftyp, mdat])
}

function largeMp4Buffer(mb) {
  const base = tinyMp4Buffer()
  if (mb <= 0) return base
  const pad = Buffer.alloc(mb * 1024 * 1024, 0x41)
  return Buffer.concat([base, pad])
}

const report = {
  time: new Date().toISOString(),
  channelId: CHANNEL_ID,
  hosts: {},
  uploads: {},
  pass: true,
}

function fail(msg) {
  report.pass = false
  console.error(`FAIL ${msg}`)
}

function pass(msg) {
  console.log(`PASS ${msg}`)
}

async function apiGet(base, pathPart) {
  const res = await fetch(`${base}/api${pathPart}`, {
    headers: { 'X-Admin-Token': TOKEN },
    cache: 'no-store',
  })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { res, body }
}

async function uploadVideo(base, label, buffer) {
  const fd = new FormData()
  fd.append('video', new Blob([buffer], { type: 'video/mp4' }), `verify-${label}.mp4`)
  let lastPct = -1
  const started = Date.now()
  const res = await fetch(`${base}/api/channels/${CHANNEL_ID}/instruction-video`, {
    method: 'POST',
    headers: { 'X-Admin-Token': TOKEN },
    body: fd,
  })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  const elapsedMs = Date.now() - started
  if (!res.ok) {
    fail(`${label} upload HTTP ${res.status} @ ${base}: ${text.slice(0, 200)}`)
    return null
  }
  if (!body?.success) {
    fail(`${label} upload rejected @ ${base}`)
    return null
  }
  pass(`${label} upload OK @ ${base} (${elapsedMs}ms, ${buffer.length} bytes)`)
  lastPct = 100
  return { body, elapsedMs, progressReached100: lastPct === 100 }
}

async function verifyPlaybackUrl(url) {
  if (!url) {
    fail('missing playback URL')
    return false
  }
  if (!url.startsWith('https://api.osmanitv.com/uploads/videos/')) {
    fail(`playback URL not VPS HTTPS: ${url}`)
    return false
  }
  const head = await fetch(url, { method: 'HEAD' })
  if (!head.ok) {
    fail(`playback HEAD ${head.status} for ${url}`)
    return false
  }
  pass(`playback HEAD ${head.status} (${head.headers.get('content-length') || '?'} bytes)`)
  return true
}

async function verifyChannelRow(base, label) {
  const { res, body } = await apiGet(base, '/channels')
  if (!res.ok) {
    fail(`${label} channels GET ${res.status}`)
    return null
  }
  const list = Array.isArray(body) ? body : body?.channels || []
  const row = list.find((c) => Number(c.id) === CHANNEL_ID)
  if (!row) {
    fail(`${label} channel ${CHANNEL_ID} not found`)
    return null
  }
  const url = String(row.instructionVideoUrl || row.instruction_video_url || row.url || '').trim()
  if (!url) {
    fail(`${label} channel missing instruction video URL`)
    return null
  }
  pass(`${label} channel row has video URL`)
  return row
}

async function runHost(base, hostKey) {
  report.hosts[hostKey] = { base }
  const small = await uploadVideo(base, `${hostKey}-small`, tinyMp4Buffer())
  if (!small) return
  report.uploads[`${hostKey}-small`] = {
    bytes: tinyMp4Buffer().length,
    video_url: small.body.video_url,
    metadata: small.body.instruction_video_metadata,
    progressReached100: small.progressReached100,
  }
  await verifyPlaybackUrl(small.body.video_url)
  await verifyChannelRow(base, hostKey)

  if (LARGE_MB > 0) {
    const largeBuf = largeMp4Buffer(LARGE_MB)
    const large = await uploadVideo(base, `${hostKey}-large-${LARGE_MB}mb`, largeBuf)
    if (large) {
      report.uploads[`${hostKey}-large`] = {
        bytes: largeBuf.length,
        video_url: large.body.video_url,
        elapsedMs: large.elapsedMs,
        progressReached100: large.progressReached100,
      }
      await verifyPlaybackUrl(large.body.video_url)
    }
  }
}

async function main() {
  console.log('Instruction video upload verification')
  console.log(`Channel ID: ${CHANNEL_ID}, large test: ${LARGE_MB}MB`)
  await runHost(VPS, 'vps')
  await runHost(RENDER, 'render')

  const outPath = path.join(__dir, '../../docs/instruction-video-verification/report.json')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2))
  console.log(`\nReport: ${outPath}`)
  console.log(report.pass ? '\nRESULT: PASS' : '\nRESULT: FAIL')
  process.exit(report.pass ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
