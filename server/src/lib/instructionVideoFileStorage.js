/**
 * Instruction VIDEO channel files — always on Contabo VPS disk, never Render local storage.
 */
import fs from 'node:fs'
import path from 'node:path'
import { ensureInstructionVideosDir, INSTRUCTION_VIDEOS_DIR } from '../multerUpload.js'
import { isRenderRuntime } from './startupReadiness.js'

function trimSlash(s) {
  return String(s ?? '').trim().replace(/\/+$/, '')
}

export function getInstructionVideoPublicOrigin() {
  const explicit = trimSlash(process.env.INSTRUCTION_VIDEO_PUBLIC_ORIGIN)
  if (explicit) return explicit
  return trimSlash(process.env.NOTIFICATION_IMAGE_PUBLIC_ORIGIN) || 'https://api.osmanitv.com'
}

export function mustUseRemoteInstructionVideoStorage() {
  const mode = String(process.env.INSTRUCTION_VIDEO_STORAGE || '').trim().toLowerCase()
  if (mode === 'local') return false
  if (mode === 'remote' || mode === 'vps') return true
  if (isRenderRuntime()) return true
  if (String(process.env.INSTRUCTION_VIDEO_VPS_INGEST_URL || '').trim()) return true
  return false
}

export function isInstructionVideoStorageHost() {
  return !mustUseRemoteInstructionVideoStorage()
}

export function getInstructionVideoIngestToken() {
  return String(
    process.env.INSTRUCTION_VIDEO_INGEST_TOKEN ||
      process.env.NOTIFICATION_IMAGE_INGEST_TOKEN ||
      process.env.ADMIN_API_TOKEN ||
      process.env.APP_UPDATE_ADMIN_TOKEN ||
      '',
  ).trim()
}

export function getInstructionVideoVpsIngestUrl(channelId) {
  const explicit = String(process.env.INSTRUCTION_VIDEO_VPS_INGEST_URL || '').trim()
  const base = explicit || `${getInstructionVideoPublicOrigin()}/api/internal/instruction-videos`
  const url = new URL(base.replace(/\/$/, ''))
  if (channelId != null && channelId !== '') {
    url.searchParams.set('channelId', String(channelId))
  }
  return url.toString()
}

export function buildInstructionVideoFilename(channelId, ext = '.mp4') {
  const safeExt = ['.mp4', '.webm', '.mkv', '.mov'].includes(ext) ? ext : '.mp4'
  const id = String(channelId ?? 'video').replace(/\D/g, '') || 'video'
  return `instruction-video-${id}-${Date.now()}${safeExt}`
}

export function assertLocalInstructionVideoWriteAllowed() {
  if (mustUseRemoteInstructionVideoStorage()) {
    throw new Error(
      'Instruction video local write blocked — videos must be stored on VPS (remote mode)',
    )
  }
}

export function prepareLocalInstructionVideoPath(channelId, ext = '.mp4') {
  assertLocalInstructionVideoWriteAllowed()
  ensureInstructionVideosDir()
  const filename = buildInstructionVideoFilename(channelId, ext)
  const dest = path.join(INSTRUCTION_VIDEOS_DIR, filename)
  return { filename, dest }
}

export function resolveInstructionVideoPublicUrl(uploadPath) {
  const raw = String(uploadPath ?? '').trim()
  if (!raw) return ''
  const pathPart = raw.startsWith('/') ? raw : `/uploads/${raw.replace(/^\/+/, '')}`
  if (!pathPart.startsWith('/uploads/videos/')) return ''
  return `${getInstructionVideoPublicOrigin()}${pathPart}`
}

export function resolveInstructionVideoDiskPath(relativePath) {
  const rel = String(relativePath ?? '').trim().replace(/^\/uploads\//, '')
  if (!rel.startsWith('videos/')) return null
  return path.join(INSTRUCTION_VIDEOS_DIR, path.basename(rel))
}

export async function verifyInstructionVideoFileExists(relativePath) {
  const disk = resolveInstructionVideoDiskPath(relativePath)
  if (!disk) return false
  try {
    await fs.promises.access(disk, fs.constants.R_OK)
    return true
  } catch {
    return false
  }
}
