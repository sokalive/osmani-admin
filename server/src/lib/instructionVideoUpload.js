/**
 * Instruction VIDEO channel upload helpers (public URL + safe path handling).
 */

function trimSlash(s) {
  return String(s ?? '').trim().replace(/\/+$/, '')
}

export const INSTRUCTION_VIDEO_UPLOAD_LOG = '[instruction-video-upload]'
export const INSTRUCTION_VIDEO_UPLOAD_TIMEOUT_MS = Math.max(
  120_000,
  Number(process.env.INSTRUCTION_VIDEO_UPLOAD_TIMEOUT_MS) || 300_000,
)

/** Relative path under uploads root, e.g. videos/instruction-video-19-123.mp4 */
export function instructionVideoRelativePath(filename) {
  const base = String(filename ?? '')
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .pop()
  if (!base) return ''
  return `videos/${base}`
}

/** Public URL path segment /uploads/videos/... */
export function instructionVideoUploadPath(filename) {
  const rel = instructionVideoRelativePath(filename)
  return rel ? `/uploads/${rel}` : ''
}

export function uploadsRelativePathFromUrl(uploadUrl) {
  const raw = String(uploadUrl ?? '').trim()
  if (!raw) return null
  if (raw.startsWith('/uploads/')) return raw.slice('/uploads/'.length)
  try {
    const parsed = new URL(raw)
    if (parsed.pathname.startsWith('/uploads/')) {
      return parsed.pathname.slice('/uploads/'.length)
    }
  } catch {
    /* ignore */
  }
  return null
}

/** Full HTTPS URL for stored instruction video (CDN when configured). */
export function buildPublicInstructionVideoUrl(req, uploadPath) {
  const rel = String(uploadPath ?? '').trim()
  if (!rel) return ''
  const pathPart = rel.startsWith('/') ? rel : `/${rel}`
  const cdn = trimSlash(process.env.BUNNY_CDN_BASE_URL || process.env.BUNNY_CDN_URL || '')
  if (cdn && pathPart.startsWith('/uploads/')) {
    return `${cdn}${pathPart}`
  }
  const base = trimSlash(process.env.BASE_URL || '') || `${req.protocol}://${req.get('host')}`
  return `${base}${pathPart}`
}
