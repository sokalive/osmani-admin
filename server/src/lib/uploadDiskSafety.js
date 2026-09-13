import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { UPLOADS_DIR, ensureUploadsDir } from './uploadPaths.js'
import {
  displayOptimizeKindFromField,
  optimizeDisplayImageBuffer,
  preserveOriginalImageBuffer,
} from './displayImageOptimize.js'

/** Minimum free bytes required before accepting a disk-backed upload (default 50 MiB). */
const DEFAULT_MIN_FREE_BYTES = Math.max(
  5 * 1024 * 1024,
  Number(process.env.UPLOAD_MIN_FREE_BYTES) || 50 * 1024 * 1024,
)

/** Reserve headroom above the incoming file size (default 10 MiB). */
const DEFAULT_WRITE_HEADROOM_BYTES = Math.max(
  1024 * 1024,
  Number(process.env.UPLOAD_WRITE_HEADROOM_BYTES) || 10 * 1024 * 1024,
)

export const UPLOAD_DISK_FULL_CODE = 'UPLOAD_DISK_FULL'
export const UPLOAD_STORAGE_UNAVAILABLE_CODE = 'UPLOAD_STORAGE_UNAVAILABLE'

export class UploadDiskError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ path?: string, cause?: unknown, correlationId?: string }} [meta]
   */
  constructor(code, message, meta = {}) {
    super(message)
    this.name = 'UploadDiskError'
    this.code = code
    this.diskPath = meta.path ?? null
    this.cause = meta.cause ?? null
    this.correlationId = meta.correlationId ?? null
  }
}

export function isEnospcError(err) {
  const code = String(err?.code ?? '').toUpperCase()
  const msg = String(err?.message ?? err ?? '').toLowerCase()
  return code === 'ENOSPC' || msg.includes('no space left on device')
}

export function correlationIdFromReq(req) {
  const hdr =
    String(req?.headers?.['x-request-id'] ?? req?.headers?.['x-correlation-id'] ?? '').trim()
  if (hdr) return hdr.slice(0, 128)
  return `up-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
}

/**
 * @param {string} targetPath
 * @returns {{ ok: true, freeBytes: number, totalBytes: number, usedPercent: number } | { ok: false, error: string }}
 */
export function statPathDiskUsage(targetPath) {
  try {
    let dir = targetPath
    try {
      const st = fs.statSync(targetPath)
      dir = st.isDirectory() ? targetPath : path.dirname(targetPath)
    } catch {
      dir = path.dirname(targetPath)
    }
    fs.mkdirSync(dir, { recursive: true })
    const st = fs.statfsSync(dir)
    const bavail = Number(st.bavail ?? st.bfree)
    const freeBytes = bavail * Number(st.bsize)
    const totalBytes = Number(st.blocks) * Number(st.bsize)
    const usedPercent = totalBytes > 0 ? Number((((totalBytes - freeBytes) / totalBytes) * 100).toFixed(2)) : 0
    return { ok: true, freeBytes, totalBytes, usedPercent, path: dir }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}

/**
 * Fail before writing when the filesystem is critically low on space.
 * @param {string} targetPath
 * @param {number} [incomingBytes]
 */
export function assertDiskSpaceForWrite(targetPath, incomingBytes = 0) {
  const usage = statPathDiskUsage(targetPath)
  if (!usage.ok) {
    throw new UploadDiskError(
      UPLOAD_STORAGE_UNAVAILABLE_CODE,
      'Upload storage is temporarily unavailable. Please try again shortly.',
      { path: targetPath, cause: usage.error },
    )
  }
  const required = DEFAULT_MIN_FREE_BYTES + DEFAULT_WRITE_HEADROOM_BYTES + Math.max(0, incomingBytes)
  if (usage.freeBytes < required) {
    throw new UploadDiskError(
      UPLOAD_DISK_FULL_CODE,
      'Server storage is full. Image upload is temporarily unavailable. Contact support.',
      { path: targetPath },
    )
  }
  return usage
}

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif'])

export function buildSafeImageFilename(originalname, mimetype) {
  const ext = path.extname(String(originalname || '')).toLowerCase()
  const safeExt = IMAGE_EXTS.has(ext) ? ext : '.jpg'
  return `${Date.now()}-${randomBytes(8).toString('hex')}${safeExt}`
}

/**
 * Persist an in-memory upload to UPLOADS_DIR with a pre-write disk check.
 * When displayOptimizeKind is set (or inferred from fieldname), stores the
 * original under MEDIA_ORIGINALS_DIR and writes an optimized display derivative
 * to the public /uploads path so mobile Home never downloads multi-MB sources.
 *
 * @param {Buffer} buffer
 * @param {{
 *   originalname?: string,
 *   mimetype?: string,
 *   filename?: string,
 *   skipMirror?: boolean,
 *   fieldname?: string,
 *   displayOptimizeKind?: 'channel_thumbnail'|'banner'|'logo'|null,
 *   skipDisplayOptimize?: boolean,
 * }} [opts]
 */
export async function persistImageBufferToUploads(buffer, opts = {}) {
  if (!buffer?.length) {
    throw new UploadDiskError(UPLOAD_STORAGE_UNAVAILABLE_CODE, 'Empty image upload')
  }
  ensureUploadsDir()

  const kind =
    opts.displayOptimizeKind ||
    displayOptimizeKindFromField(opts.fieldname) ||
    null
  const shouldOptimize = Boolean(kind) && opts.skipDisplayOptimize !== true

  let writeBuffer = buffer
  let writeMime = opts.mimetype || 'application/octet-stream'
  let optimizeMeta = null
  let originalPreserve = null

  if (shouldOptimize) {
    try {
      optimizeMeta = await optimizeDisplayImageBuffer(buffer, {
        kind,
        mime: opts.mimetype,
        originalname: opts.originalname,
      })
      if (!optimizeMeta.skipped) {
        writeBuffer = optimizeMeta.buffer
        writeMime =
          optimizeMeta.format === 'jpeg'
            ? 'image/jpeg'
            : optimizeMeta.format === 'png'
              ? 'image/png'
              : optimizeMeta.format === 'webp'
                ? 'image/webp'
                : writeMime
      }
    } catch (optErr) {
      console.warn('[uploads] display optimize failed — storing original bytes', optErr?.message || optErr)
      optimizeMeta = { error: String(optErr?.message || optErr), skipped: true }
    }
  }

  let filename = String(opts.filename || '')
  if (!filename) {
    if (optimizeMeta && !optimizeMeta.skipped && optimizeMeta.ext) {
      filename = `${Date.now()}-${randomBytes(8).toString('hex')}.${optimizeMeta.ext}`
    } else {
      filename = buildSafeImageFilename(opts.originalname, writeMime)
    }
  } else if (optimizeMeta && !optimizeMeta.skipped && optimizeMeta.ext) {
    // Align extension with actual encoded format when caller supplied a name.
    const base = path.basename(filename, path.extname(filename))
    filename = `${base}.${optimizeMeta.ext}`
  }

  if (shouldOptimize) {
    try {
      originalPreserve = await preserveOriginalImageBuffer(buffer, filename)
    } catch (presErr) {
      console.warn('[uploads] original preserve failed', presErr?.message || presErr)
    }
  }

  const fullPath = path.join(UPLOADS_DIR, filename)
  assertDiskSpaceForWrite(fullPath, writeBuffer.length)
  try {
    await fsPromises.writeFile(fullPath, writeBuffer)
  } catch (e) {
    if (isEnospcError(e)) {
      await fsPromises.unlink(fullPath).catch(() => {})
      throw new UploadDiskError(
        UPLOAD_DISK_FULL_CODE,
        'Server storage is full. Image upload is temporarily unavailable. Contact support.',
        { path: fullPath, cause: e },
      )
    }
    throw new UploadDiskError(
      UPLOAD_STORAGE_UNAVAILABLE_CODE,
      'Upload storage is temporarily unavailable. Please try again shortly.',
      { path: fullPath, cause: e },
    )
  }

  if (!opts.skipMirror) {
    try {
      const { mirrorAdminMediaToVps } = await import('./adminMediaMirror.js')
      await mirrorAdminMediaToVps({
        filename,
        buffer: writeBuffer,
        contentType: writeMime,
      })
    } catch (mirrorErr) {
      // Roll back local orphan so Contabo/apps never reference a Render-only file.
      await fsPromises.unlink(fullPath).catch(() => {})
      console.error('[uploads] VPS media mirror failed — upload rolled back', mirrorErr)
      throw new UploadDiskError(
        UPLOAD_STORAGE_UNAVAILABLE_CODE,
        'Image could not be saved to the primary media store. Please try again.',
        { path: fullPath, cause: mirrorErr },
      )
    }
  }

  if (optimizeMeta && !optimizeMeta.skipped) {
    console.info(
      `[uploads] display optimize kind=${kind} ${optimizeMeta.originalBytes}→${optimizeMeta.compressedBytes}B (-${optimizeMeta.savedPercent}%) ${optimizeMeta.width}x${optimizeMeta.height}`,
    )
  }

  return {
    filename,
    fullPath,
    relativePath: `/uploads/${filename}`,
    optimize: optimizeMeta,
    originalPreserve,
  }
}

/**
 * Confirm uploaded image exists on disk with non-zero size before DB reference update.
 * @param {string} filename
 */
export async function assertUploadedImageFileReady(filename) {
  const base = path.basename(String(filename || '').trim())
  if (!base) {
    throw new UploadDiskError(UPLOAD_STORAGE_UNAVAILABLE_CODE, 'Uploaded image file name missing')
  }
  const fullPath = path.join(UPLOADS_DIR, base)
  let st
  try {
    st = await fsPromises.stat(fullPath)
  } catch (e) {
    throw new UploadDiskError(
      UPLOAD_STORAGE_UNAVAILABLE_CODE,
      'Uploaded image file was not saved correctly. Please try again.',
      { path: fullPath, cause: e },
    )
  }
  if (!st.isFile() || st.size <= 0) {
    throw new UploadDiskError(
      UPLOAD_STORAGE_UNAVAILABLE_CODE,
      'Uploaded image file is empty. Please try again.',
      { path: fullPath },
    )
  }
  return { filename: base, fullPath, bytes: st.size, relativePath: `/uploads/${base}` }
}

/**
 * Materialize multer memoryStorage file onto disk for legacy handlers expecting req.file.filename.
 * @param {import('express').Request} req
 */
export async function materializeMemoryUploadFile(req) {
  const file = req?.file
  if (!file || file.filename) return file
  if (!file.buffer?.length) return file
  const persisted = await persistImageBufferToUploads(file.buffer, {
    originalname: file.originalname,
    mimetype: file.mimetype,
    fieldname: file.fieldname,
    displayOptimizeKind: displayOptimizeKindFromField(file.fieldname),
  })
  file.filename = persisted.filename
  file.path = persisted.fullPath
  file.optimize = persisted.optimize || null
  delete file.buffer
  return file
}

/** @alias materializeMemoryUploadFile */
export const finalizeMemoryImageUpload = materializeMemoryUploadFile

export function uploadErrorJson(err, req, { status = 500 } = {}) {
  const correlationId = correlationIdFromReq(req)
  if (err instanceof UploadDiskError) {
    const code = err.code
    const httpStatus = code === UPLOAD_DISK_FULL_CODE ? 507 : 503
    return {
      status: httpStatus,
      body: {
        ok: false,
        success: false,
        error: err.message,
        code,
        correlationId,
      },
    }
  }
  if (isEnospcError(err)) {
    return {
      status: 507,
      body: {
        ok: false,
        success: false,
        error: 'Server storage is full. Image upload is temporarily unavailable. Contact support.',
        code: UPLOAD_DISK_FULL_CODE,
        correlationId,
      },
    }
  }
  return {
    status,
    body: {
      ok: false,
      success: false,
      error: String(err?.message || err || 'Upload failed. Please try again.'),
      code: 'UPLOAD_FAILED',
      correlationId,
    },
  }
}

export function sendUploadError(res, err, req, opts) {
  const out = uploadErrorJson(err, req, opts)
  return res.status(out.status).json(out.body)
}
