/**
 * Stream delivery strategy with controlled rollout (Phase 4 Step 2).
 */
import { buildPublicStreamProxyUrl, PROXY_MOUNT_STREAM } from '../lib/streamManifestRewrite.js'
import { getStreamSegmentDeliveryHealth } from './streamSegmentDelivery.js'
import { normalizeUpstreamHeaders } from './streamUpstreamHeaders.js'
import {
  buildSignedDirectStreamPlaybackUrl,
  getDirectStreamTokenTtlSec,
  isDirectStreamSigningConfigured,
  isDirectStreamSigningEnabled,
  STREAM_DIRECT_MOUNT,
} from './directStreamSigning.js'
import { getStreamDeliveryMetricsSnapshot, recordPlaybackAssigned } from './streamDeliveryMetrics.js'
import {
  getDirectStreamRolloutAllowlist,
  getDirectStreamRolloutPercent,
  getRolloutHealthSnapshot,
  isChannelEligibleForDirectPlayback,
  isDirectStreamCutoverEnabled,
  isStreamPlaybackForceProxy,
} from './streamDeliveryRollout.js'

export const STREAM_DELIVERY_MODES = Object.freeze(['proxy', 'direct', 'hybrid'])

export { isStreamPlaybackForceProxy }

function envTruthy(name, defaultVal = false) {
  const raw = process.env[name]
  if (raw === undefined || raw === null || String(raw).trim() === '') return defaultVal
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase())
}

export function getStreamDeliveryMode() {
  const raw = String(process.env.STREAM_DELIVERY_MODE || 'hybrid').trim().toLowerCase()
  return STREAM_DELIVERY_MODES.includes(raw) ? raw : 'hybrid'
}

export function shouldExposeDirectStreamUrlInApi() {
  const mode = getStreamDeliveryMode()
  if (!isDirectStreamSigningEnabled()) return false
  if (mode === 'proxy') return false
  return mode === 'hybrid' || mode === 'direct'
}

function streamHeaders(channel) {
  const upstream = String(channel?.upstreamUrl || channel?.url || '').trim()
  return normalizeUpstreamHeaders(
    {
      referer: channel?.referer,
      origin: channel?.origin,
      userAgent: channel?.userAgent,
    },
    upstream,
  )
}

function buildProxyPlayback(req, upstreamUrl, hdr) {
  const proxy = buildPublicStreamProxyUrl(req, upstreamUrl, hdr)
  return proxy || upstreamUrl || ''
}

/**
 * @param {import('express').Request|null} req
 * @param {{ channelId?: string|number, upstreamUrl?: string, referer?: string, origin?: string, userAgent?: string }} channel
 */
export function resolveStreamSourceDelivery(req, channel) {
  const hdr = streamHeaders(channel)
  const upstream = String(channel?.upstreamUrl || channel?.url || '').trim()
  const mode = getStreamDeliveryMode()
  const channelId = channel?.channelId ?? channel?.id
  const rollout = isChannelEligibleForDirectPlayback(channelId)

  const proxyUrl = upstream ? buildProxyPlayback(req, upstream, hdr) : ''

  let directStreamUrl = ''
  if (shouldExposeDirectStreamUrlInApi() && upstream) {
    directStreamUrl = buildSignedDirectStreamPlaybackUrl(req, upstream, hdr, { channelId })
  }

  const canPlayDirect = rollout.eligible && Boolean(directStreamUrl)
  let playbackUrl = proxyUrl
  let playbackSource = 'proxy'
  let streamDeliveryEffective = 'proxy'

  if (canPlayDirect) {
    playbackUrl = directStreamUrl
    playbackSource = 'direct'
    streamDeliveryEffective = 'direct'
    recordPlaybackAssigned('direct')
  } else {
    recordPlaybackAssigned('proxy')
  }

  return {
    mode,
    playbackUrl,
    playbackSource,
    streamDeliveryEffective,
    directStreamUrl,
    proxyUrl,
    proxyPlaybackUrl: proxyUrl,
    upstreamUrl: upstream,
    headers: hdr,
    rolloutEligible: rollout.eligible,
    rolloutReason: rollout.reason,
  }
}

function forceProxyNote(mode) {
  return isStreamPlaybackForceProxy() || !isDirectStreamCutoverEnabled()
}

export function buildChannelStreamDelivery(req, channelRow) {
  const m = channelRow || {}
  const primary = resolveStreamSourceDelivery(req, {
    channelId: m.id,
    upstreamUrl: m.url,
    referer: m.referer,
    origin: m.origin,
    userAgent: m.userAgent,
  })
  const backup1 = resolveStreamSourceDelivery(req, {
    channelId: m.id,
    upstreamUrl: m.backupStream1,
    referer: m.referer,
    origin: m.origin,
    userAgent: m.userAgent,
  })
  const backup2 = resolveStreamSourceDelivery(req, {
    channelId: m.id,
    upstreamUrl: m.backupStream2,
    referer: m.referer,
    origin: m.origin,
    userAgent: m.userAgent,
  })

  return {
    stream_delivery_mode: primary.mode,
    stream_delivery_effective: primary.streamDeliveryEffective,
    direct_stream_url: primary.directStreamUrl || null,
    direct_stream_url_backup1: backup1.directStreamUrl || null,
    direct_stream_url_backup2: backup2.directStreamUrl || null,
    proxy_playback_url: primary.proxyPlaybackUrl || null,
    proxy_playback_url_backup1: backup1.proxyPlaybackUrl || null,
    proxy_playback_url_backup2: backup2.proxyPlaybackUrl || null,
    direct_stream_rollout: primary.rolloutEligible,
    playbackUrl: primary.playbackUrl,
    backupPlayback1: backup1.playbackUrl || (m.backupStream1 ?? ''),
    backupPlayback2: backup2.playbackUrl || (m.backupStream2 ?? ''),
    proxyPrimary: primary.proxyUrl,
    proxyBackup1: backup1.proxyUrl,
    proxyBackup2: backup2.proxyUrl,
    streamProxy: {
      route: `/${PROXY_MOUNT_STREAM}`,
      primaryUrl: primary.proxyUrl,
      backupUrls: [backup1.proxyUrl, backup2.proxyUrl].filter(Boolean),
      headers: primary.headers,
      directRoute: `/${STREAM_DIRECT_MOUNT}`,
      directPrimaryUrl: primary.directStreamUrl || null,
      playbackSource: primary.playbackSource,
      playbackFallbackUrl: primary.proxyPlaybackUrl || null,
      rolloutReason: primary.rolloutReason,
    },
  }
}

export function getStreamDeliveryHealthSnapshot() {
  const mode = getStreamDeliveryMode()
  const signingEnabled = isDirectStreamSigningEnabled()
  const signingConfigured = isDirectStreamSigningConfigured()
  const forceProxy = isStreamPlaybackForceProxy()
  const cutoverEnabled = isDirectStreamCutoverEnabled()
  const rollout = getRolloutHealthSnapshot()
  const metrics = getStreamDeliveryMetricsSnapshot()
  const segments = getStreamSegmentDeliveryHealth()

  return {
    ok: signingEnabled ? signingConfigured : true,
    stream_delivery_mode: mode,
    signing_enabled: signingEnabled,
    signing_configured: signingConfigured,
    token_ttl_sec: getDirectStreamTokenTtlSec(),
    playback_force_proxy: forceProxy,
    cutover_enabled: cutoverEnabled,
    production_cutover_active: cutoverEnabled && !forceProxy,
    expose_direct_stream_url_in_api: shouldExposeDirectStreamUrlInApi(),
    rollout,
    segments,
    metrics,
    routes: {
      proxy: `/${PROXY_MOUNT_STREAM}`,
      direct: `/${STREAM_DIRECT_MOUNT}`,
      bunny_segment_origin: `/${segments.origin_pull_route}`,
    },
    hls_note: segments.production_segment_offload_active
      ? 'Manifest via stream-direct (token); HLS segments via signed Bunny CDN URLs; Render origin-pull on Bunny cache miss only.'
      : 'Segment offload inactive — set STREAM_SEGMENT_DELIVERY=bunny, BUNNY_STREAM_CDN_BASE_URL, and rollout percent.',
    notes: forceProxy
      ? 'playbackUrl is proxy-only (STREAM_PLAYBACK_FORCE_PROXY=1).'
      : !cutoverEnabled
        ? 'Cutover disabled — set DIRECT_STREAM_CUTOVER_ENABLED=1 and rollout allowlist/percent to begin.'
        : 'Controlled rollout may set playbackUrl to signed stream-direct for eligible channels.',
    rollback: {
      playback_proxy: 'STREAM_PLAYBACK_FORCE_PROXY=1',
      segment_proxy: 'STREAM_SEGMENT_FORCE_PROXY=1 or STREAM_SEGMENT_DELIVERY=proxy',
    },
  }
}

export { getDirectStreamRolloutPercent, getDirectStreamRolloutAllowlist, isDirectStreamCutoverEnabled }
