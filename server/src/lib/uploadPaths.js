import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Prefer UPLOAD_DIR for production (Render persistent disk); fallback for local dev only. */
function resolveUploadsDir() {
  const raw = process.env.UPLOAD_DIR?.trim()
  if (raw) return path.resolve(raw)
  return path.join(__dirname, '../../uploads')
}

export const UPLOADS_DIR = resolveUploadsDir()
export const INSTRUCTION_VIDEOS_DIR = path.join(UPLOADS_DIR, 'videos')

export function ensureUploadsDir() {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true })
}
