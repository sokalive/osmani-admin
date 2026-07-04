import fs from 'node:fs'
import path from 'node:path'
import multer from 'multer'
import { createInstructionVideoMulterStorage } from './lib/instructionVideoMulterStorage.js'
import {
  finalizeMemoryImageUpload,
  isEnospcError,
  sendUploadError,
  UploadDiskError,
} from './lib/uploadDiskSafety.js'
import { UPLOADS_DIR, INSTRUCTION_VIDEOS_DIR, ensureUploadsDir } from './lib/uploadPaths.js'

export { UPLOADS_DIR, INSTRUCTION_VIDEOS_DIR, ensureUploadsDir }
export { finalizeMemoryImageUpload, sendUploadError, isEnospcError, UploadDiskError }

function mustSkipLocalInstructionVideoDir() {
  const mode = String(process.env.INSTRUCTION_VIDEO_STORAGE || '').trim().toLowerCase()
  if (mode === 'local') return false
  if (mode === 'remote' || mode === 'vps') return true
  if (isRenderRuntime()) return true
  if (String(process.env.INSTRUCTION_VIDEO_VPS_INGEST_URL || '').trim()) return true
  return false
}

export function ensureInstructionVideosDir() {
  if (mustSkipLocalInstructionVideoDir()) return
  ensureUploadsDir()
  fs.mkdirSync(INSTRUCTION_VIDEOS_DIR, { recursive: true })
  try {
    fs.mkdirSync(path.join(UPLOADS_DIR, 'apks'), { recursive: true })
  } catch (e) {
    console.warn('[uploads] apks mkdir skipped:', e?.message || e)
  }
}

function isRenderRuntime() {
  return String(process.env.RENDER || '').trim().toLowerCase() === 'true'
}

function probeWritableDir(dir) {
  const probe = path.join(dir, `.write-probe-${process.pid}`)
  fs.writeFileSync(probe, Buffer.from('ok'))
  fs.unlinkSync(probe)
}

let uploadStorageReady = false
let uploadStorageLastError = null

export function isUploadStorageReady() {
  return uploadStorageReady
}

export function getUploadStorageLastError() {
  return uploadStorageLastError
}

/**
 * Create upload dirs and probe writability. Never exits the process — uploads may be degraded.
 */
export function initUploadStorage() {
  const result = {
    ok: false,
    uploadsDir: UPLOADS_DIR,
    instructionVideosDir: INSTRUCTION_VIDEOS_DIR,
    writable: false,
    error: null,
  }

  if (process.env.REQUIRE_UPLOAD_DIR === '1' && !process.env.UPLOAD_DIR?.trim()) {
    result.error = 'REQUIRE_UPLOAD_DIR=1 but UPLOAD_DIR is not set'
    uploadStorageReady = false
    uploadStorageLastError = result.error
    console.error('[uploads] WARN:', result.error)
    return result
  }

  try {
    if (isRenderRuntime()) {
      fs.mkdirSync('/var/render/media', { recursive: true })
    }
    ensureUploadsDir()
    if (!mustSkipLocalInstructionVideoDir()) {
      fs.mkdirSync(INSTRUCTION_VIDEOS_DIR, { recursive: true })
    }
    try {
      fs.mkdirSync(path.join(UPLOADS_DIR, 'apks'), { recursive: true })
    } catch (e) {
      console.warn('[uploads] apks mkdir skipped:', e?.message || e)
    }
  } catch (e) {
    result.error = `mkdir failed: ${e?.message || e}`
    uploadStorageReady = false
    uploadStorageLastError = result.error
    console.error('[uploads] WARN: could not create upload directories:', result.error)
    return result
  }

  try {
    fs.accessSync(UPLOADS_DIR, fs.constants.R_OK | fs.constants.W_OK)
    if (!mustSkipLocalInstructionVideoDir()) {
      fs.accessSync(INSTRUCTION_VIDEOS_DIR, fs.constants.R_OK | fs.constants.W_OK)
    }
    result.writable = true
  } catch (e) {
    result.error = `upload path not readable/writable: ${e?.message || e}`
    uploadStorageReady = false
    uploadStorageLastError = result.error
    console.error('[uploads] WARN:', result.error, {
      uploadsDir: UPLOADS_DIR,
      instructionVideosDir: INSTRUCTION_VIDEOS_DIR,
    })
    return result
  }

  try {
    probeWritableDir(UPLOADS_DIR)
    if (!mustSkipLocalInstructionVideoDir()) {
      probeWritableDir(INSTRUCTION_VIDEOS_DIR)
    }
    result.ok = true
    uploadStorageReady = true
    uploadStorageLastError = null
  } catch (e) {
    result.error = `cannot write probe file under UPLOAD_DIR: ${e?.message || e}`
    uploadStorageReady = false
    uploadStorageLastError = result.error
    console.error('[uploads] WARN: probe write failed:', {
      uploadsDir: UPLOADS_DIR,
      instructionVideosDir: INSTRUCTION_VIDEOS_DIR,
      error: e?.message || e,
    })
    console.error('[uploads] WARN: server starting in degraded mode — uploads disabled until disk is writable')
  }

  return result
}

/** @deprecated Prefer initUploadStorage — kept for callers; never exits. */
export function assertUploadStorageReady() {
  return initUploadStorage()
}

function listRegularFiles(dir) {
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const files = []
  for (const name of names) {
    if (name.startsWith('.')) continue
    const full = path.join(dir, name)
    try {
      const st = fs.statSync(full)
      if (st.isFile()) files.push(name)
    } catch {
      /* skip */
    }
  }
  return files.sort()
}

/** Startup diagnostics — called once after assertUploadStorageReady */
export function logUploadStorageDiagnostics() {
  const exists = fs.existsSync(UPLOADS_DIR)
  const files = listRegularFiles(UPLOADS_DIR)
  const sample = files.slice(0, 8)

  if (process.env.RENDER === 'true' && !process.env.UPLOAD_DIR?.trim()) {
    console.warn(
      '[uploads] WARN: RENDER=true but UPLOAD_DIR is unset — files go to ephemeral disk under repo path and WILL be lost on deploy. Set UPLOAD_DIR to your persistent disk mount.',
    )
  }

  console.log('[uploads] resolved UPLOAD_DIR:', UPLOADS_DIR)
  console.log('[uploads] instruction videos dir:', INSTRUCTION_VIDEOS_DIR)
  console.log('[uploads] directory exists:', exists)
  console.log('[uploads] image file count:', files.length)
  if (sample.length) console.log('[uploads] sample files:', sample.join(', '))
}

export async function getMediaHealthSnapshot() {
  let exists = false
  let writable = false
  let fileCount = 0
  let sampleFiles = []
  let sampleReadOk = false
  let sampleBytes = 0
  let error = null

  try {
    exists = fs.existsSync(UPLOADS_DIR)
    if (!exists) {
      return {
        ok: false,
        uploadsDir: UPLOADS_DIR,
        exists,
        writable,
        fileCount,
        sampleFiles,
        sampleReadOk,
        sampleBytes,
        error: 'upload directory missing',
      }
    }
    fs.accessSync(UPLOADS_DIR, fs.constants.W_OK)
    writable = true
    const files = listRegularFiles(UPLOADS_DIR)
    fileCount = files.length
    sampleFiles = files.slice(0, 5)
    if (sampleFiles.length > 0) {
      const first = path.join(UPLOADS_DIR, sampleFiles[0])
      const buf = await fs.promises.readFile(first)
      sampleReadOk = buf.length > 0
      sampleBytes = buf.length
    } else {
      sampleReadOk = true
    }
    return {
      ok: true,
      uploadsDir: UPLOADS_DIR,
      exists,
      writable,
      fileCount,
      sampleFiles,
      sampleReadOk,
      sampleBytes,
      error: null,
    }
  } catch (e) {
    error = String(e?.message || e)
    return {
      ok: false,
      uploadsDir: UPLOADS_DIR,
      exists,
      writable,
      fileCount,
      sampleFiles,
      sampleReadOk,
      sampleBytes,
      error,
    }
  }
}

/** Image uploads use memory first, then controlled disk persist (avoids multer partial ENOSPC writes). */
const imageMemoryStorage = multer.memoryStorage()

function fileFilter(_req, file, cb) {
  if (!file.mimetype.startsWith('image/')) {
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Only image uploads are allowed'))
    return
  }
  cb(null, true)
}

export const uploadThumbnail = multer({
  storage: imageMemoryStorage,
  fileFilter,
  limits: { fileSize: 6 * 1024 * 1024 },
})

/** Banner hero image — multipart field name `image` */
export const uploadBannerImage = multer({
  storage: imageMemoryStorage,
  fileFilter,
  limits: { fileSize: 8 * 1024 * 1024 },
})

function paymentProviderLogoFilter(_req, file, cb) {
  const mime = String(file?.mimetype || '').toLowerCase()
  const allowed = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp'])
  if (!allowed.has(mime)) {
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Only PNG/JPG/WebP logo uploads are allowed'))
    return
  }
  cb(null, true)
}

/** Payment provider logo — multipart field name `logo` */
export const uploadPaymentProviderLogo = multer({
  storage: imageMemoryStorage,
  fileFilter: paymentProviderLogoFilter,
  limits: { fileSize: 4 * 1024 * 1024 },
})

function notificationImageFilter(_req, file, cb) {
  const mime = String(file?.mimetype || '').toLowerCase()
  const allowed = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp'])
  if (!allowed.has(mime)) {
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Only JPG, JPEG, PNG and WEBP are allowed'))
    return
  }
  cb(null, true)
}

/** Admin notification image — field `image`, optimized server-side after upload */
export const uploadNotificationImage = multer({
  storage: multer.memoryStorage(),
  fileFilter: notificationImageFilter,
  limits: {
    fileSize: Math.max(
      1024 * 1024,
      Number(process.env.NOTIFICATION_IMAGE_MAX_INPUT_BYTES) || 15 * 1024 * 1024,
    ),
  },
})

const instructionVideoStorage = createInstructionVideoMulterStorage()

function instructionVideoFilter(_req, file, cb) {
  const mime = String(file?.mimetype || '').toLowerCase()
  const allowed = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska'])
  if (!allowed.has(mime) && !mime.startsWith('video/')) {
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Only video uploads are allowed'))
    return
  }
  cb(null, true)
}

/** Instruction channel video — multipart field `video` */
export const uploadInstructionVideo = multer({
  storage: instructionVideoStorage,
  fileFilter: instructionVideoFilter,
  limits: {
    fileSize: Math.max(
      10 * 1024 * 1024,
      Number(process.env.INSTRUCTION_VIDEO_MAX_BYTES) || 250 * 1024 * 1024,
    ),
  },
})
