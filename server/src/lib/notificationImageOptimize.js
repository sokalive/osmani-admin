import sharp from 'sharp'
import {
  storeOptimizedNotificationImage,
} from './notificationImageStorage.js'

export const NOTIFICATION_IMAGE_MAX_INPUT_BYTES = Math.max(
  512 * 1024,
  Number(process.env.NOTIFICATION_IMAGE_MAX_INPUT_BYTES) || 15 * 1024 * 1024,
)

const MAX_DIMENSION = Math.max(320, Number(process.env.NOTIFICATION_IMAGE_MAX_DIMENSION) || 1200)
const JPEG_QUALITY = Math.min(95, Math.max(50, Number(process.env.NOTIFICATION_IMAGE_JPEG_QUALITY) || 82))
const WEBP_QUALITY = Math.min(95, Math.max(50, Number(process.env.NOTIFICATION_IMAGE_WEBP_QUALITY) || 85))

const ALLOWED_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp'])

export function isAllowedNotificationImageMime(mime) {
  const m = String(mime || '')
    .toLowerCase()
    .split(';')[0]
    .trim()
  return ALLOWED_MIME.has(m)
}

export function parseNotificationImageDataUrl(raw) {
  const compact = String(raw || '').replace(/\s/g, '')
  const m = /^data:image\/(jpe?g|png|webp);base64,(.+)$/i.exec(compact)
  if (!m) return null
  let buf
  try {
    buf = Buffer.from(m[2], 'base64')
  } catch {
    return null
  }
  const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase()
  const mime =
    ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'png' ? 'image/png' : 'image/webp'
  return { buf, mime, ext }
}

/**
 * Resize and re-encode notification images for storage and OneSignal delivery.
 */
export async function optimizeNotificationImageBuffer(inputBuf, { mime = '' } = {}) {
  if (!inputBuf?.length) throw new Error('Image is empty')
  if (inputBuf.length > NOTIFICATION_IMAGE_MAX_INPUT_BYTES) {
    const mb = Math.round(NOTIFICATION_IMAGE_MAX_INPUT_BYTES / (1024 * 1024))
    throw new Error(`Image exceeds ${mb} MB upload limit`)
  }

  const originalBytes = inputBuf.length
  let pipeline = sharp(inputBuf, { failOn: 'none' }).rotate()
  const meta = await pipeline.metadata()
  if (!meta.width || !meta.height) {
    throw new Error('Unsupported or corrupt image (use JPG, JPEG, PNG or WEBP)')
  }

  const preferWebp = String(mime).toLowerCase().includes('webp')
  const hasAlpha = meta.hasAlpha === true

  pipeline = pipeline.resize(MAX_DIMENSION, MAX_DIMENSION, {
    fit: 'inside',
    withoutEnlargement: true,
  })

  let outBuf
  let outFormat
  let outExt

  if (hasAlpha) {
    outBuf = await pipeline.png({ compressionLevel: 9, palette: true }).toBuffer()
    outFormat = 'png'
    outExt = 'png'
    if (outBuf.length > 512 * 1024) {
      outBuf = await sharp(inputBuf)
        .rotate()
        .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
        .flatten({ background: { r: 0, g: 0, b: 0 } })
        .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
        .toBuffer()
      outFormat = 'jpeg'
      outExt = 'jpg'
    }
  } else if (preferWebp) {
    outBuf = await pipeline.webp({ quality: WEBP_QUALITY }).toBuffer()
    outFormat = 'webp'
    outExt = 'webp'
    const jpegBuf = await sharp(inputBuf)
      .rotate()
      .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer()
    if (jpegBuf.length < outBuf.length * 0.92) {
      outBuf = jpegBuf
      outFormat = 'jpeg'
      outExt = 'jpg'
    }
  } else {
    outBuf = await pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer()
    outFormat = 'jpeg'
    outExt = 'jpg'
  }

  const outMeta = await sharp(outBuf).metadata()
  const compressedBytes = outBuf.length
  const savedPercent =
    originalBytes > 0 ? Math.max(0, Math.round((1 - compressedBytes / originalBytes) * 1000) / 10) : 0

  return {
    buffer: outBuf,
    originalBytes,
    compressedBytes,
    width: outMeta.width || meta.width,
    height: outMeta.height || meta.height,
    format: outFormat,
    ext: outExt,
    savedPercent,
  }
}

export async function persistOptimizedNotificationImage(inputBuf, opts = {}) {
  const optimized = await optimizeNotificationImageBuffer(inputBuf, opts)
  const stored = await storeOptimizedNotificationImage(optimized.buffer, { ext: optimized.ext })
  return {
    imageForDb: stored.imageForDb,
    originalBytes: optimized.originalBytes,
    compressedBytes: optimized.compressedBytes,
    width: optimized.width,
    height: optimized.height,
    format: optimized.format,
    savedPercent: optimized.savedPercent,
    storage: stored.storage,
  }
}
