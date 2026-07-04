#!/usr/bin/env node
/**
 * Production-safe image upload pipeline verification (read + optional multipart smoke).
 *
 *   node server/scripts/verify-image-upload-production.mjs
 *   API=https://api.osmanitv.com ADMIN_API_TOKEN=... node server/scripts/verify-image-upload-production.mjs
 */
const API = String(process.env.API || process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/$/, '')
const TOKEN = String(process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '3030').trim()

const checks = []

function pass(name, detail) {
  checks.push({ name, ok: true, detail })
  console.log(`PASS ${name}: ${detail}`)
}

function fail(name, detail) {
  checks.push({ name, ok: false, detail })
  console.error(`FAIL ${name}: ${detail}`)
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { cache: 'no-store', ...opts })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { raw: text.slice(0, 400) }
  }
  return { res, body }
}

/** 1x1 PNG */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

async function main() {
  console.log('=== Image upload production verification ===\n')
  console.log(`API: ${API}\n`)

  const cutover = await fetchJson(`${API}/api/runtime/cutover-status`)
  if (!cutover.res.ok || cutover.body?.ok !== true) {
    fail('cutover-status', `HTTP ${cutover.res.status}`)
    process.exit(1)
  }
  pass('cutover-status', `commit=${String(cutover.body.commit || '').slice(0, 12)} uploads=${cutover.body.uploads_dir}`)
  const disk = cutover.body.uploads_disk
  if (disk?.free_bytes != null) {
    const freeMb = (disk.free_bytes / (1024 * 1024)).toFixed(1)
    pass('uploads-disk-public', `free=${freeMb}MiB used=${disk.used_percent}%`)
    if (disk.free_bytes < 10 * 1024 * 1024) {
      fail('uploads-disk-low', `only ${freeMb}MiB free — ENOSPC risk remains`)
    }
  } else {
    fail('uploads-disk-public', disk?.error || 'missing uploads_disk (deploy storage fix first)')
  }

  const forensics = await fetchJson(`${API}/api/runtime/storage-forensics`, {
    headers: { 'x-admin-token': TOKEN },
  })
  if (forensics.res.ok && forensics.body?.ok === true) {
    const root = forensics.body.disk_bytes?.root_filesystem
    const uploads = forensics.body.disk_bytes?.uploads_dir
    pass(
      'storage-forensics',
      `root_free=${root?.freeBytes ?? '?'} uploads_free=${uploads?.freeBytes ?? '?'} files=${forensics.body.uploads_file_count_top_level}`,
    )
    if (Array.isArray(forensics.body.df_h)) {
      const rootRow = forensics.body.df_h.find((r) => r.mount === '/') || forensics.body.df_h[0]
      if (rootRow) pass('df-h-root', `${rootRow.use_percent} used on ${rootRow.mount} avail=${rootRow.available}`)
    }
  } else {
    fail('storage-forensics', `HTTP ${forensics.res.status} ${forensics.body?.error || ''}`)
  }

  const form = new FormData()
  form.append('image', new Blob([TINY_PNG], { type: 'image/png' }), 'verify-tiny.png')
  const prep = await fetchJson(`${API}/api/notifications/prepare-image`, {
    method: 'POST',
    headers: { 'x-admin-token': TOKEN },
    body: form,
  })
  if (prep.res.ok && prep.body?.ok === true && prep.body?.imageForDb?.startsWith('/uploads/notif-')) {
    pass('notification-prepare-image', `${prep.body.imageForDb} bytes=${prep.body.compressedBytes}`)
    const pushUrl = prep.body.pushImageUrl || `${API}${prep.body.imageForDb}`
    const head = await fetch(pushUrl, { method: 'HEAD', signal: AbortSignal.timeout(10_000) })
    if (head.ok) pass('notification-image-url', pushUrl)
    else fail('notification-image-url', `HEAD ${head.status} ${pushUrl}`)
  } else {
    fail(
      'notification-prepare-image',
      `HTTP ${prep.res.status} code=${prep.body?.code || 'n/a'} err=${prep.body?.error || prep.body?.raw || ''}`,
    )
  }

  const failed = checks.filter((c) => !c.ok)
  console.log(`\n=== ${checks.length - failed.length}/${checks.length} passed ===`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
