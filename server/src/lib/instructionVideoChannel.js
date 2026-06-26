import { parseVersionCode, APP_UPDATE_NEVER_MIN } from './appUpdateTargeting.js'
import { resolveInstructionVideoPublicUrl } from './instructionVideoFileStorage.js'

export const INSTRUCTION_VIDEO_CHANNEL_NAME = 'VIDEO'
export const INSTRUCTION_VISIBILITY = {
  ALL: 'all',
  BELOW_V24: 'below_v24',
  HIDE_V24_PLUS: 'hide_v24_plus',
}

export function isInstructionVideoChannelName(name) {
  return String(name ?? '').trim().toUpperCase() === INSTRUCTION_VIDEO_CHANNEL_NAME
}

export function normalizeInstructionVisibility(raw) {
  const v = String(raw ?? '').trim().toLowerCase()
  if (v === INSTRUCTION_VISIBILITY.BELOW_V24) return INSTRUCTION_VISIBILITY.BELOW_V24
  if (v === INSTRUCTION_VISIBILITY.HIDE_V24_PLUS) return INSTRUCTION_VISIBILITY.HIDE_V24_PLUS
  return INSTRUCTION_VISIBILITY.ALL
}

/** Relative /uploads/videos/... path from DB row (instruction_video_url preferred). */
export function instructionVideoRelativePathFromStored(row) {
  const candidates = [row?.instructionVideoUrl, row?.instruction_video_url, row?.url]
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)
  for (const raw of candidates) {
    if (raw.startsWith('/uploads/videos/')) return raw
    if (raw.startsWith('http')) {
      try {
        const p = new URL(raw).pathname
        if (p.startsWith('/uploads/videos/')) return p
      } catch {
        /* ignore */
      }
    }
    if (raw.startsWith('videos/')) return `/uploads/${raw.replace(/^\/+/, '')}`
  }
  return ''
}

/** Canonical HTTPS VPS playback URL + relative path for API clients. */
export function resolveInstructionVideoPlaybackForApi(row, _req) {
  const relative = instructionVideoRelativePathFromStored(row)
  const fromColumn = String(row?.instructionVideoUrl ?? row?.instruction_video_url ?? '').trim()
  const full =
    resolveInstructionVideoPublicUrl(relative) ||
    (fromColumn.startsWith('http') ? fromColumn : '') ||
    resolveInstructionVideoPublicUrl(fromColumn)
  return { relative, full }
}

export function instructionChannelVisibleForClient(row, clientVersionInput) {
  const showInApp = row?.showInApp !== false && row?.show_in_app !== false
  if (!showInApp || row?.isActive === false || row?.is_active === false) return false
  const mode = normalizeInstructionVisibility(row?.instructionVisibility ?? row?.instruction_visibility)
  const client = parseVersionCode(clientVersionInput)
  if (mode === INSTRUCTION_VISIBILITY.ALL) return true
  if (client <= 0) return mode === INSTRUCTION_VISIBILITY.BELOW_V24
  if (mode === INSTRUCTION_VISIBILITY.BELOW_V24) return client < APP_UPDATE_NEVER_MIN
  if (mode === INSTRUCTION_VISIBILITY.HIDE_V24_PLUS) return client < APP_UPDATE_NEVER_MIN
  return true
}

export function instructionChannelApiExtras(row, req, clientVersion) {
  const { relative, full: videoUrl } = resolveInstructionVideoPlaybackForApi(row, req)
  const status = String(row?.instructionVideoStatus ?? row?.instruction_video_status ?? '').trim()
  return {
    instructionVideo: true,
    instruction_video: true,
    isInstructionVideo: true,
    is_instruction_video: true,
    instructionVisibility: normalizeInstructionVisibility(
      row?.instructionVisibility ?? row?.instruction_visibility,
    ),
    instruction_visibility: normalizeInstructionVisibility(
      row?.instructionVisibility ?? row?.instruction_visibility,
    ),
    portraitPlayback: true,
    portrait_playback: true,
    offlineCacheHint: 'recommended',
    offline_cache_hint: 'recommended',
    videoUrl,
    video_url: videoUrl,
    streamUrl: videoUrl,
    stream_url: videoUrl,
    instructionVideoUrl: videoUrl,
    instruction_video_url: videoUrl,
    instructionVideoStatus: status || (videoUrl ? 'ready' : ''),
    instruction_video_status: status || (videoUrl ? 'ready' : ''),
    accessType: 'free',
    accessPremium: false,
    access_premium: false,
    instruction_video_path: relative,
  }
}
