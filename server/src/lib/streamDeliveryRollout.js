import crypto from 'node:crypto'
import { isDirectStreamSigningConfigured } from './directStreamSigning.js'

function envTruthy(name, defaultVal = false) {
  const raw = process.env[name]
  if (raw === undefined || raw === null || String(raw).trim() === '') return defaultVal
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase())
}

/** Master switch for assigning direct URLs to playbackUrl (default off). */
export function isDirectStreamCutoverEnabled() {
  return envTruthy('DIRECT_STREAM_CUTOVER_ENABLED', false)
}

/** Emergency rollback: forces all playbackUrl to proxy regardless of rollout. */
export function isStreamPlaybackForceProxy() {
  return envTruthy('STREAM_PLAYBACK_FORCE_PROXY', true)
}

export function getDirectStreamRolloutPercent() {
  const n = Number(process.env.DIRECT_STREAM_ROLLOUT_PERCENT)
  if (!Number.isFinite(n)) return 0
  return Math.min(100, Math.max(0, Math.trunc(n)))
}

function rolloutSalt() {
  return String(process.env.DIRECT_STREAM_ROLLOUT_SALT || 'osmani-stream-rollout-v1').trim()
}

/** @returns {Set<string>} */
export function getDirectStreamRolloutAllowlist() {
  const raw = String(process.env.DIRECT_STREAM_ROLLOUT_CHANNEL_IDS || '').trim()
  if (!raw) return new Set()
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
}

function stableBucket(channelId, salt) {
  const id = String(channelId ?? '').trim()
  if (!id) return 100
  const digest = crypto.createHash('sha256').update(`${salt}:${id}`).digest()
  return digest[0] % 100
}

/**
 * Whether this channel may receive direct playbackUrl (signed /stream-direct).
 */
export function isChannelEligibleForDirectPlayback(channelId) {
  if (!isDirectStreamCutoverEnabled()) {
    return { eligible: false, reason: 'cutover_disabled' }
  }
  if (isStreamPlaybackForceProxy()) {
    return { eligible: false, reason: 'force_proxy' }
  }
  if (!isDirectStreamSigningConfigured()) {
    return { eligible: false, reason: 'signing_not_configured' }
  }

  const id = String(channelId ?? '').trim()
  const allowlist = getDirectStreamRolloutAllowlist()
  if (allowlist.size > 0) {
    if (allowlist.has(id)) return { eligible: true, reason: 'allowlist' }
    return { eligible: false, reason: 'not_in_allowlist' }
  }

  const percent = getDirectStreamRolloutPercent()
  if (percent <= 0) return { eligible: false, reason: 'rollout_percent_zero' }
  if (percent >= 100) return { eligible: true, reason: 'rollout_percent_100' }

  const bucket = stableBucket(id, rolloutSalt())
  if (bucket < percent) return { eligible: true, reason: 'rollout_percent' }
  return { eligible: false, reason: 'rollout_percent_excluded' }
}

export function getRolloutHealthSnapshot() {
  const allowlist = [...getDirectStreamRolloutAllowlist()]
  const percent = getDirectStreamRolloutPercent()
  return {
    cutover_enabled: isDirectStreamCutoverEnabled(),
    force_proxy: isStreamPlaybackForceProxy(),
    rollout_percent: percent,
    allowlist_channel_ids: allowlist,
    allowlist_count: allowlist.length,
    effective_strategy:
      isStreamPlaybackForceProxy() || !isDirectStreamCutoverEnabled()
        ? 'proxy_only'
        : allowlist.length > 0
          ? 'allowlist_then_percent'
          : percent > 0
            ? 'percent_only'
            : 'proxy_only',
    rollback: {
      instant: [
        'Set STREAM_PLAYBACK_FORCE_PROXY=1',
        'Set DIRECT_STREAM_CUTOVER_ENABLED=0',
        'Set DIRECT_STREAM_ROLLOUT_PERCENT=0',
      ],
    },
  }
}
