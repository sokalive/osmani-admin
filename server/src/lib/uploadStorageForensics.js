import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import {
  getMediaHealthSnapshot,
  getUploadStorageLastError,
  initUploadStorage,
  isUploadStorageReady,
} from '../multerUpload.js'
import { UPLOADS_DIR } from './uploadPaths.js'
import { statPathDiskUsage } from './uploadDiskSafety.js'
import { getNotificationImageStorageDiagnostics } from './notificationImageStorage.js'

function readDirFileCount(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => !f.startsWith('.')).length
  } catch {
    return null
  }
}

async function dirByteSize(dir, { maxDepth = 2, maxEntries = 5000 } = {}) {
  let total = 0
  let files = 0
  let truncated = false

  async function walk(current, depth) {
    if (depth > maxDepth || files >= maxEntries) {
      truncated = true
      return
    }
    let entries = []
    try {
      entries = await fsPromises.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue
      const full = path.join(current, ent.name)
      if (ent.isFile()) {
        try {
          const st = await fsPromises.stat(full)
          total += st.size
          files += 1
        } catch {
          /* skip */
        }
      } else if (ent.isDirectory() && depth < maxDepth) {
        await walk(full, depth + 1)
      }
    }
  }

  await walk(dir, 0)
  return { bytes: total, fileCount: files, truncated }
}

function spawnText(cmd, args, timeoutMs = 8000) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs })
    return {
      ok: r.status === 0,
      stdout: String(r.stdout || '').trim(),
      stderr: String(r.stderr || '').trim(),
      exitCode: r.status,
    }
  } catch (e) {
    return { ok: false, stdout: '', stderr: String(e?.message || e), exitCode: -1 }
  }
}

function parseDfOutput(text) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length < 2) return []
  const rows = []
  for (const line of lines.slice(1)) {
    const parts = line.split(/\s+/)
    if (parts.length < 6) continue
    rows.push({
      filesystem: parts[0],
      size: parts[1],
      used: parts[2],
      available: parts[3],
      use_percent: parts[4],
      mount: parts.slice(5).join(' '),
    })
  }
  return rows
}

function parseDfInodeOutput(text) {
  return parseDfOutput(text).map((r) => ({
    filesystem: r.filesystem,
    inodes: r.size,
    iused: r.used,
    ifree: r.available,
    iuse_percent: r.use_percent,
    mount: r.mount,
  }))
}

function topLevelDu(baseDir, maxEntries = 12) {
  const r = spawnText('du', ['-xhd1', baseDir])
  if (!r.ok) return { ok: false, error: r.stderr || r.stdout || 'du failed', entries: [] }
  const entries = r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^([\d.]+[KMGTP]?)\s+(.+)$/)
      if (!m) return null
      return { size: m[1], path: m[2] }
    })
    .filter(Boolean)
    .sort((a, b) => {
      const parse = (s) => {
        const n = parseFloat(s)
        if (s.endsWith('G')) return n * 1024 ** 3
        if (s.endsWith('M')) return n * 1024 ** 2
        if (s.endsWith('K')) return n * 1024
        if (s.endsWith('T')) return n * 1024 ** 4
        return n
      }
      return parse(b.size) - parse(a.size)
    })
    .slice(0, maxEntries)
  return { ok: true, entries }
}

function lsofDeletedOpen(maxLines = 25) {
  const r = spawnText('lsof', ['+L1'])
  if (!r.ok) return { ok: false, error: r.stderr || 'lsof unavailable', lines: [] }
  const lines = r.stdout.split('\n').slice(0, maxLines)
  return { ok: true, lines, truncated: r.stdout.split('\n').length > maxLines }
}

/**
 * Production storage forensics snapshot (safe, read-only).
 */
export async function collectUploadStorageForensics() {
  const uploadsUsage = statPathDiskUsage(UPLOADS_DIR)
  const rootUsage = statPathDiskUsage('/')
  const tmpUsage = statPathDiskUsage(os.tmpdir())
  const uploadDirSize = await dirByteSize(UPLOADS_DIR, { maxDepth: 1 })
  const mediaHealth = await getMediaHealthSnapshot()
  const storageInit = initUploadStorage()

  const dfH = spawnText('df', ['-h'])
  const dfI = spawnText('df', ['-i'])

  const duVar = topLevelDu('/var')
  const duTmp = topLevelDu('/tmp')
  const duHome = topLevelDu('/home')
  const duUploadParent = topLevelDu(path.dirname(UPLOADS_DIR))

  const pm2Logs = spawnText('du', ['-sh', '/root/.pm2/logs'])
  const nginxLogs = spawnText('du', ['-sh', '/var/log/nginx'])
  const journal = spawnText('journalctl', ['--disk-usage'])

  const probePatterns = ['.write-probe-', '.upload-tmp-']
  let orphanProbeCount = 0
  try {
    const names = await fsPromises.readdir(UPLOADS_DIR)
    orphanProbeCount = names.filter((n) => probePatterns.some((p) => n.includes(p))).length
  } catch {
    /* ignore */
  }

  return {
    ok: true,
    collected_at: new Date().toISOString(),
    hostname: os.hostname(),
    platform: process.platform,
    node_version: process.version,
    uploads_dir: UPLOADS_DIR,
    uploads_parent: path.dirname(UPLOADS_DIR),
    tmp_dir: os.tmpdir(),
    upload_storage_ready: isUploadStorageReady(),
    upload_storage_last_error: getUploadStorageLastError(),
    upload_storage_init: storageInit,
    media_health: mediaHealth,
    notification_image_storage: getNotificationImageStorageDiagnostics(),
    disk_bytes: {
      uploads_dir: uploadsUsage.ok ? uploadsUsage : { ok: false, error: uploadsUsage.error },
      root_filesystem: rootUsage.ok ? rootUsage : { ok: false, error: rootUsage.error },
      tmp_dir: tmpUsage.ok ? tmpUsage : { ok: false, error: tmpUsage.error },
    },
    uploads_dir_size: uploadDirSize,
    uploads_file_count_top_level: readDirFileCount(UPLOADS_DIR),
    orphan_probe_file_count: orphanProbeCount,
    df_h: dfH.ok ? parseDfOutput(dfH.stdout) : { error: dfH.stderr || 'df -h failed' },
    df_i: dfI.ok ? parseDfInodeOutput(dfI.stdout) : { error: dfI.stderr || 'df -i failed' },
    du_top_level: {
      var: duVar,
      tmp: duTmp,
      home: duHome,
      upload_parent: duUploadParent,
    },
    logs: {
      pm2: pm2Logs.ok ? pm2Logs.stdout : { error: pm2Logs.stderr },
      nginx: nginxLogs.ok ? nginxLogs.stdout : { error: nginxLogs.stderr },
      journal: journal.ok ? journal.stdout : { error: journal.stderr },
    },
    deleted_open_files: lsofDeletedOpen(),
  }
}

/**
 * Remove only proven-disposable artifacts under UPLOADS_DIR (write probes, stale .upload-tmp-*).
 * Does not delete customer media referenced by DB.
 */
export async function cleanupDisposableUploadArtifacts({
  maxAgeMs = 24 * 60 * 60 * 1000,
  dryRun = false,
} = {}) {
  const removed = []
  let scanned = 0
  const now = Date.now()
  const patterns = [/^\.write-probe-/, /^\.upload-tmp-/]
  try {
    const names = await fsPromises.readdir(UPLOADS_DIR)
    for (const name of names) {
      if (!patterns.some((re) => re.test(name))) continue
      scanned += 1
      const full = path.join(UPLOADS_DIR, name)
      try {
        const st = await fsPromises.stat(full)
        if (now - st.mtimeMs > maxAgeMs) {
          const entry = { name, bytes: st.size, age_ms: now - st.mtimeMs }
          if (!dryRun) {
            await fsPromises.unlink(full)
          }
          removed.push(entry)
        }
      } catch {
        /* skip */
      }
    }
  } catch (e) {
    return { ok: false, error: String(e?.message || e), scanned, removed, dryRun }
  }
  const before = statPathDiskUsage(UPLOADS_DIR)
  return {
    ok: true,
    dryRun,
    scanned,
    removed_count: removed.length,
    reclaimed_bytes: removed.reduce((n, r) => n + (r.bytes || 0), 0),
    removed: removed.slice(0, 50),
    disk_after: before.ok ? before : null,
  }
}
