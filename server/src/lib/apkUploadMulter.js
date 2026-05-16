import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import multer from 'multer'
import { UPLOADS_DIR, ensureUploadsDir } from '../multerUpload.js'

export const APK_UPLOADS_DIR = path.join(UPLOADS_DIR, 'apks')

export function ensureApkUploadsDir() {
  ensureUploadsDir()
  fs.mkdirSync(APK_UPLOADS_DIR, { recursive: true })
}

const apkStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    try {
      ensureApkUploadsDir()
      cb(null, APK_UPLOADS_DIR)
    } catch (e) {
      cb(e)
    }
  },
  filename: (_req, file, cb) => {
    const base = path.basename(String(file.originalname || 'upload.apk')).replace(/[^\w.\-]+/g, '_')
    const safe = base.toLowerCase().endsWith('.apk') ? base : `${base}.apk`
    cb(null, `upload-${Date.now()}-${randomBytes(4).toString('hex')}-${safe}`)
  },
})

function apkFileFilter(_req, file, cb) {
  const name = String(file?.originalname || '').toLowerCase()
  const mime = String(file?.mimetype || '').toLowerCase()
  const okMime =
    mime === 'application/vnd.android.package-archive' ||
    mime === 'application/octet-stream' ||
    mime === 'application/zip'
  if (!name.endsWith('.apk') && !okMime) {
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Only .apk files are allowed'))
    return
  }
  cb(null, true)
}

const maxBytes = Math.max(
  5 * 1024 * 1024,
  Number(process.env.APP_UPDATE_MAX_APK_BYTES) || 300 * 1024 * 1024,
)

export const uploadApkFile = multer({
  storage: apkStorage,
  fileFilter: apkFileFilter,
  limits: { fileSize: maxBytes, files: 1 },
})
