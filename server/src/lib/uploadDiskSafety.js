import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { UPLOADS_DIR, ensureUploadsDir } from './uploadPaths.js'

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
 * @param {Buffer} buffer
 * @param {{ originalname?: string, mimetype?: string, filename?: string }} [opts]
 */
export async function persistImageBufferToUploads(buffer, opts = {}) {
  if (!buffer?.length) {
    throw new UploadDiskError(UPLOAD_STORAGE_UNAVAILABLE_CODE, 'Empty image upload')
  }
  ensureUploadsDir()
  const filename = String(opts.filename || buildSafeImageFilename(opts.originalname, opts.mimetype))
  const fullPath = path.join(UPLOADS_DIR, filename)
  assertDiskSpaceForWrite(fullPath, buffer.length)
  try {
    await fsPromises.writeFile(fullPath, buffer)
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
  return { filename, fullPath, relativePath: `/uploads/${filename}` }
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
  })
  file.filename = persisted.filename
  file.path = persisted.fullPath
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
