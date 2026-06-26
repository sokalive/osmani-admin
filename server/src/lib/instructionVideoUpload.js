/**
 * Instruction VIDEO channel upload helpers (public URL + safe path handling).
 */
import { resolveInstructionVideoPublicUrl } from './instructionVideoFileStorage.js'

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

/** Full HTTPS URL for stored instruction video (always VPS origin, never Bunny CDN). */
export function buildPublicInstructionVideoUrl(_req, uploadPath) {
  const vps = resolveInstructionVideoPublicUrl(uploadPath)
  if (vps) return vps
  const rel = String(uploadPath ?? '').trim()
  if (!rel) return ''
  const pathPart = rel.startsWith('/') ? rel : `/${rel}`
  return resolveInstructionVideoPublicUrl(pathPart) || pathPart
}
