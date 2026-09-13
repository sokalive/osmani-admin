/**
 * One-time / idempotent optimization of existing channel + banner display images.
 *
 * - Preserves originals under MEDIA_ORIGINALS_DIR (default /var/lib/osmani/media-originals)
 * - Writes optimized derivatives into public UPLOADS_DIR
 * - Updates DB paths when extension/format changes
 * - Bumps updated_at for API cache-buster (?v=)
 * - Does NOT delete originals, channels, banners, or touch payments/subscriptions
 *
 * Usage (on VPS):
 *   cd /var/www/osmani-admin-api/server
 *   node scripts/optimize-existing-display-images.mjs
 *   DRY_RUN=1 node scripts/optimize-existing-display-images.mjs
 */
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import '../src/loadEnv.js'
import { Client } from 'pg'
import { UPLOADS_DIR, ensureUploadsDir } from '../src/lib/uploadPaths.js'
import {
  getMediaOriginalsRoot,
  optimizeDisplayImageBuffer,
  preserveOriginalImageBuffer,
} from '../src/lib/displayImageOptimize.js'

const DRY_RUN = ['1', 'true', 'yes'].includes(String(process.env.DRY_RUN || '').trim().toLowerCase())
const __dirname = path.dirname(fileURLToPath(import.meta.url))

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function diskPathFromUploadRel(rel) {
  const clean = String(rel || '').split('?')[0]
  const base = clean.replace(/^\/uploads\//, '').replace(/^uploads\//, '')
  return path.join(UPLOADS_DIR, base)
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required')
  ensureUploadsDir()
  const originalsRoot = getMediaOriginalsRoot()
  await fsPromises.mkdir(path.join(originalsRoot, 'uploads'), { recursive: true })

  const inventoryPath = path.join(originalsRoot, `inventory-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()

  const channels = (
    await client.query(
      `SELECT id, name, thumbnail, updated_at FROM channels WHERE thumbnail IS NOT NULL AND btrim(thumbnail) <> '' ORDER BY id`,
    )
  ).rows
  const banners = (
    await client.query(
      `SELECT id, image, updated_at FROM banners WHERE image IS NOT NULL AND btrim(image) <> '' ORDER BY id`,
    )
  ).rows

  /** @type {any[]} */
  const work = []
  for (const r of channels) {
    work.push({ kind: 'channel_thumbnail', table: 'channels', id: r.id, name: r.name, field: 'thumbnail', rel: r.thumbnail })
  }
  for (const r of banners) {
    work.push({ kind: 'banner', table: 'banners', id: r.id, name: `banner-${r.id}`, field: 'image', rel: r.image })
  }

  const report = {
    started_at: new Date().toISOString(),
    dry_run: DRY_RUN,
    originals_root: originalsRoot,
    uploads_dir: UPLOADS_DIR,
    before_total_bytes: 0,
    after_total_bytes: 0,
    items: [],
  }

  for (const item of work) {
    const file = diskPathFromUploadRel(item.rel)
    const entry = {
      ...item,
      source_rel: item.rel,
      source_file: file,
      exists: false,
      before_bytes: null,
      after_bytes: null,
      before_sha256: null,
      after_sha256: null,
      before_dims: null,
      after_dims: null,
      action: 'skip',
      new_rel: item.rel,
    }

    if (!fs.existsSync(file)) {
      entry.action = 'missing_file'
      report.items.push(entry)
      continue
    }

    // Idempotent: already pointing at a display derivative — do not re-encode.
    if (/\.display\.[a-z0-9]+$/i.test(String(item.rel).split('?')[0])) {
      const bufExisting = await fsPromises.readFile(file)
      entry.exists = true
      entry.before_bytes = bufExisting.length
      entry.after_bytes = bufExisting.length
      entry.before_sha256 = sha256(bufExisting)
      entry.after_sha256 = entry.before_sha256
      entry.action = 'already_display_derivative'
      report.before_total_bytes += bufExisting.length
      report.after_total_bytes += bufExisting.length
      report.items.push(entry)
      continue
    }

    const buf = await fsPromises.readFile(file)
    entry.exists = true
    entry.before_bytes = buf.length
    entry.before_sha256 = sha256(buf)
    report.before_total_bytes += buf.length

    let meta
    try {
      const sharp = (await import('sharp')).default
      meta = await sharp(buf, { failOn: 'none' }).metadata()
      entry.before_dims = { width: meta.width, height: meta.height, format: meta.format, hasAlpha: meta.hasAlpha }
    } catch (e) {
      entry.action = 'unreadable'
      entry.error = String(e?.message || e)
      report.after_total_bytes += buf.length
      report.items.push(entry)
      continue
    }

    const optimized = await optimizeDisplayImageBuffer(buf, { kind: item.kind, originalname: path.basename(file) })
    if (optimized.skipped) {
      entry.action = 'already_efficient'
      entry.after_bytes = buf.length
      entry.after_sha256 = entry.before_sha256
      entry.after_dims = entry.before_dims
      report.after_total_bytes += buf.length
      report.items.push(entry)
      continue
    }

    const stem = path.basename(file, path.extname(file)).replace(/\.display$/i, '')
    const newFilename = `${stem}.display.${optimized.ext}`
    const newRel = `/uploads/${newFilename}`
    const newPath = path.join(UPLOADS_DIR, newFilename)

    entry.action = DRY_RUN ? 'would_optimize' : 'optimized'
    entry.after_bytes = optimized.compressedBytes
    entry.after_sha256 = sha256(optimized.buffer)
    entry.after_dims = { width: optimized.width, height: optimized.height, format: optimized.format }
    entry.saved_percent = optimized.savedPercent
    entry.new_rel = newRel
    entry.original_preserve = path.join(originalsRoot, 'uploads', path.basename(file))

    if (!DRY_RUN) {
      await preserveOriginalImageBuffer(buf, path.basename(file))
      await fsPromises.writeFile(newPath, optimized.buffer)
      if (item.table === 'channels') {
        await client.query(
          `UPDATE channels SET thumbnail = $1, updated_at = now() WHERE id = $2`,
          [newRel, item.id],
        )
      } else {
        await client.query(
          `UPDATE banners SET image = $1, updated_at = now() WHERE id = $2`,
          [newRel, item.id],
        )
      }
      // Keep old public file in place as well as originals dir (do not delete).
      // Optionally leave a tiny pointer sidecar for operators.
      const note = `${file}.ORIGINAL_PRESERVED.txt`
      await fsPromises.writeFile(
        note,
        `Original preserved at ${entry.original_preserve}\nOptimized display: ${newRel}\n${new Date().toISOString()}\n`,
      )
    }

    report.after_total_bytes += optimized.compressedBytes
    report.items.push(entry)
  }

  report.finished_at = new Date().toISOString()
  report.before_total_mb = Number((report.before_total_bytes / 1024 / 1024).toFixed(2))
  report.after_total_mb = Number((report.after_total_bytes / 1024 / 1024).toFixed(2))
  report.reduction_percent =
    report.before_total_bytes > 0
      ? Number((100 * (1 - report.after_total_bytes / report.before_total_bytes)).toFixed(1))
      : 0

  await fsPromises.writeFile(inventoryPath, JSON.stringify(report, null, 2))
  const localCopy = path.join(__dirname, `optimize-display-report-${Date.now()}.json`)
  await fsPromises.writeFile(localCopy, JSON.stringify(report, null, 2))

  console.log(
    JSON.stringify(
      {
        dry_run: DRY_RUN,
        inventoryPath,
        localCopy,
        before_mb: report.before_total_mb,
        after_mb: report.after_total_mb,
        reduction_percent: report.reduction_percent,
        optimized: report.items.filter((i) => i.action === 'optimized' || i.action === 'would_optimize').length,
        skipped: report.items.filter((i) => i.action === 'already_efficient').length,
        missing: report.items.filter((i) => i.action === 'missing_file').length,
      },
      null,
      2,
    ),
  )

  await client.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
