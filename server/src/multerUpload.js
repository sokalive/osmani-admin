import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import multer from 'multer'
import { randomBytes } from 'node:crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const UPLOADS_DIR = path.join(__dirname, '../uploads')

export function ensureUploadsDir() {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true })
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    ensureUploadsDir()
    cb(null, UPLOADS_DIR)
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg'
    const safeExt = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif'].includes(ext) ? ext : '.jpg'
    const name = `${Date.now()}-${randomBytes(8).toString('hex')}${safeExt}`
    cb(null, name)
  },
})

function fileFilter(_req, file, cb) {
  if (!file.mimetype.startsWith('image/')) {
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Only image uploads are allowed'))
    return
  }
  cb(null, true)
}

export const uploadThumbnail = multer({
  storage,
  fileFilter,
  limits: { fileSize: 6 * 1024 * 1024 },
})

/** Banner hero image — multipart field name `image` */
export const uploadBannerImage = multer({
  storage,
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
  storage,
  fileFilter: paymentProviderLogoFilter,
  limits: { fileSize: 4 * 1024 * 1024 },
})
