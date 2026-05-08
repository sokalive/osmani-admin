#!/usr/bin/env node
/**
 * Copy uploaded images into UPLOAD_DIR (e.g. after attaching a persistent disk).
 *
 * Usage (from server/):
 *   UPLOAD_DIR=/var/render/media node scripts/migrate-uploads.mjs --from ./uploads
 *   node scripts/migrate-uploads.mjs --from /path/to/backup --dry-run
 *
 * Does not delete the source. Safe to re-run (overwrites same filenames).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const serverRoot = path.join(__dirname, '..')

function parseArgs() {
  const argv = process.argv.slice(2)
  const out = { from: null, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from' && argv[i + 1]) {
      out.from = argv[++i]
    } else if (argv[i] === '--dry-run') {
      out.dryRun = true
    }
  }
  return out
}

function resolveUploadDir() {
  const raw = process.env.UPLOAD_DIR?.trim()
  if (raw) return path.resolve(raw)
  return path.join(serverRoot, 'uploads')
}

async function collectFiles(dir, base = dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files = []
  for (const ent of entries) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      files.push(...(await collectFiles(full, base)))
    } else if (ent.isFile()) {
      files.push(full)
    }
  }
  return files
}

async function main() {
  const { from, dryRun } = parseArgs()
  if (!from) {
    console.error('Usage: UPLOAD_DIR=/target node scripts/migrate-uploads.mjs --from <source-dir> [--dry-run]')
    process.exit(1)
  }

  const destRoot = resolveUploadDir()
  const srcRoot = path.resolve(from)

  console.log('[migrate-uploads] source:', srcRoot)
  console.log('[migrate-uploads] UPLOAD_DIR:', destRoot)
  console.log('[migrate-uploads] dry-run:', dryRun)

  let stat
  try {
    stat = await fs.stat(srcRoot)
  } catch (e) {
    console.error('[migrate-uploads] source path missing:', e.message)
    process.exit(1)
  }
  if (!stat.isDirectory()) {
    console.error('[migrate-uploads] --from must be a directory')
    process.exit(1)
  }

  const files = await collectFiles(srcRoot)
  const imageFiles = files.filter((f) => /\.(png|jpe?g|gif|webp|avif)$/i.test(f))

  console.log('[migrate-uploads] files to copy:', imageFiles.length)

  if (dryRun) {
    for (const f of imageFiles.slice(0, 20)) {
      console.log('  would copy', path.relative(srcRoot, f))
    }
    if (imageFiles.length > 20) console.log(`  ... and ${imageFiles.length - 20} more`)
    return
  }

  await fs.mkdir(destRoot, { recursive: true })

  let copied = 0
  let skipped = 0
  for (const abs of imageFiles) {
    const rel = path.relative(srcRoot, abs)
    const dest = path.join(destRoot, rel)
    await fs.mkdir(path.dirname(dest), { recursive: true })
    try {
      await fs.copyFile(abs, dest)
      copied++
    } catch (e) {
      console.warn('[migrate-uploads] skip', rel, e.message)
      skipped++
    }
  }

  console.log('[migrate-uploads] done. copied:', copied, 'skipped:', skipped)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
