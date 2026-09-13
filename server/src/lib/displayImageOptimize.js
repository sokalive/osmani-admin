/**
 * Display-image optimizer for channel thumbnails, banners, and logos.
 * Preserves visual artwork while capping dimensions and re-encoding for mobile Home.
 * Does not touch payments, subscriptions, or app UI.
 */
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

/** Channel/poster tiles: ~2–3× retina for common Home card widths (~120–180 CSS px). */
export const CHANNEL_THUMB_MAX_DIMENSION = Math.max(
  240,
  Number(process.env.DISPLAY_IMAGE_CHANNEL_MAX_DIMENSION) || 480,
)

/** Home banners: wider hero strip, still far below multi-megapixel uploads. */
export const BANNER_MAX_DIMENSION = Math.max(
  640,
  Number(process.env.DISPLAY_IMAGE_BANNER_MAX_DIMENSION) || 1280,
)

/** Payment / small logos. */
export const LOGO_MAX_DIMENSION = Math.max(
  96,
  Number(process.env.DISPLAY_IMAGE_LOGO_MAX_DIMENSION) || 256,
)

const JPEG_QUALITY = Math.min(92, Math.max(55, Number(process.env.DISPLAY_IMAGE_JPEG_QUALITY) || 82))
const WEBP_QUALITY = Math.min(92, Math.max(55, Number(process.env.DISPLAY_IMAGE_WEBP_QUALITY) || 80))

const KIND_MAX = {
  channel_thumbnail: CHANNEL_THUMB_MAX_DIMENSION,
  banner: BANNER_MAX_DIMENSION,
  logo: LOGO_MAX_DIMENSION,
}

/**
 * @param {string|undefined|null} fieldname multer field or explicit kind
 * @returns {'channel_thumbnail'|'banner'|'logo'|null}
 */
export function displayOptimizeKindFromField(fieldname) {
  const f = String(fieldname || '')
    .trim()
    .toLowerCase()
  if (f === 'thumbnail' || f === 'channel_thumbnail' || f === 'poster') return 'channel_thumbnail'
  if (f === 'image' || f === 'banner' || f === 'banner_image') return 'banner'
  if (f === 'logo' || f === 'payment_logo') return 'logo'
  return null
}

/**
 * @param {Buffer} inputBuf
 * @param {{ kind?: string, mime?: string }} [opts]
 */
export async function optimizeDisplayImageBuffer(inputBuf, opts = {}) {
  if (!inputBuf?.length) throw new Error('Image is empty')

  const kind = KIND_MAX[opts.kind] ? opts.kind : 'channel_thumbnail'
  const maxDim = KIND_MAX[kind] || CHANNEL_THUMB_MAX_DIMENSION
  const originalBytes = inputBuf.length

  let pipeline = sharp(inputBuf, { failOn: 'none' }).rotate()
  const meta = await pipeline.metadata()
  if (!meta.width || !meta.height) {
    throw new Error('Unsupported or corrupt image (use JPG, JPEG, PNG or WEBP)')
  }

  const hasAlpha = meta.hasAlpha === true
  const needsResize =
    meta.width > maxDim || meta.height > maxDim || originalBytes > 180 * 1024

  pipeline = pipeline.resize(maxDim, maxDim, {
    fit: 'inside',
    withoutEnlargement: true,
  })

  let outBuf
  let outFormat
  let outExt

  if (hasAlpha) {
    // Prefer lossless-feeling WebP with alpha; fall back to PNG if tiny gain.
    const webpBuf = await sharp(inputBuf, { failOn: 'none' })
      .rotate()
      .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: Math.min(90, WEBP_QUALITY + 5), alphaQuality: 90 })
      .toBuffer()
    const pngBuf = await sharp(inputBuf, { failOn: 'none' })
      .rotate()
      .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9, palette: true })
      .toBuffer()
    if (webpBuf.length <= pngBuf.length * 1.05) {
      outBuf = webpBuf
      outFormat = 'webp'
      outExt = 'webp'
    } else {
      outBuf = pngBuf
      outFormat = 'png'
      outExt = 'png'
    }
  } else {
    const webpBuf = await pipeline.webp({ quality: WEBP_QUALITY }).toBuffer()
    const jpegBuf = await sharp(inputBuf, { failOn: 'none' })
      .rotate()
      .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer()
    if (webpBuf.length <= jpegBuf.length) {
      outBuf = webpBuf
      outFormat = 'webp'
      outExt = 'webp'
    } else {
      outBuf = jpegBuf
      outFormat = 'jpeg'
      outExt = 'jpg'
    }
  }

  // Never grow the payload for already-small assets.
  if (!needsResize && outBuf.length >= originalBytes * 0.98) {
    const outMeta = await sharp(inputBuf).metadata()
    return {
      buffer: inputBuf,
      skipped: true,
      originalBytes,
      compressedBytes: originalBytes,
      width: outMeta.width || meta.width,
      height: outMeta.height || meta.height,
      format: String(outMeta.format || 'unknown'),
      ext: path.extname(String(opts.originalname || '')).replace(/^\./, '') || 'bin',
      savedPercent: 0,
      kind,
      maxDim,
    }
  }

  const outMeta = await sharp(outBuf).metadata()
  const compressedBytes = outBuf.length
  const savedPercent =
    originalBytes > 0 ? Math.max(0, Math.round((1 - compressedBytes / originalBytes) * 1000) / 10) : 0

  return {
    buffer: outBuf,
    skipped: false,
    originalBytes,
    compressedBytes,
    width: outMeta.width || meta.width,
    height: outMeta.height || meta.height,
    format: outFormat,
    ext: outExt,
    savedPercent,
    kind,
    maxDim,
  }
}

/**
 * Directory for immutable originals (never served to the app by default).
 */
export function getMediaOriginalsRoot() {
  const fromEnv = String(process.env.MEDIA_ORIGINALS_DIR || '').trim()
  if (fromEnv) return fromEnv
  return '/var/lib/osmani/media-originals'
}

/**
 * Persist a copy of the original upload under MEDIA_ORIGINALS_DIR.
 * @param {Buffer} buffer
 * @param {string} publicFilename basename that will be (or was) under /uploads
 */
export async function preserveOriginalImageBuffer(buffer, publicFilename) {
  const root = getMediaOriginalsRoot()
  const destDir = path.join(root, 'uploads')
  await fsPromises.mkdir(destDir, { recursive: true })
  const base = path.basename(String(publicFilename || `original-${Date.now()}`))
  const dest = path.join(destDir, base)
  if (!fs.existsSync(dest)) {
    await fsPromises.writeFile(dest, buffer)
  } else {
    // Keep a sidecar with timestamp if public name reused.
    const alt = path.join(destDir, `${Date.now()}-${base}`)
    await fsPromises.writeFile(alt, buffer)
    return { path: alt, relativePath: `/originals/uploads/${path.basename(alt)}` }
  }
  return { path: dest, relativePath: `/originals/uploads/${base}` }
}
