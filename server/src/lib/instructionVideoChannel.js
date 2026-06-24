import { parseVersionCode, APP_UPDATE_NEVER_MIN } from './appUpdateTargeting.js'

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

/** Whether this instruction channel row should appear for the client app version. */
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
  const rel = String(row?.url ?? '').trim()
  const videoUrl = rel.startsWith('/uploads/') && req
    ? `${req.protocol}://${req.get('host')}${rel}`
    : rel.startsWith('http')
      ? rel
      : rel
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
    accessType: 'free',
    accessPremium: false,
    access_premium: false,
  }
}
