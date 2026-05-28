/**
 * Stream delivery strategy (Phase 4 foundation).
 * Production playback remains on Render proxy until an explicit cutover flag is set.
 */
import { buildPublicStreamProxyUrl, PROXY_MOUNT_STREAM } from '../routes/streamProxy.js'
import {
  buildSignedDirectStreamPlaybackUrl,
  getDirectStreamTokenTtlSec,
  isDirectStreamSigningConfigured,
  isDirectStreamSigningEnabled,
  STREAM_DIRECT_MOUNT,
} from './directStreamSigning.js'

export const STREAM_DELIVERY_MODES = Object.freeze(['proxy', 'direct', 'hybrid'])

function envTruthy(name, defaultVal = false) {
  const raw = process.env[name]
  if (raw === undefined || raw === null || String(raw).trim() === '') return defaultVal
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase())
}

/** Global delivery mode from env (default hybrid). */
export function getStreamDeliveryMode() {
  const raw = String(process.env.STREAM_DELIVERY_MODE || 'hybrid').trim().toLowerCase()
  return STREAM_DELIVERY_MODES.includes(raw) ? raw : 'hybrid'
}

/**
 * When true (default), `playbackUrl` always uses Render proxy even if mode is direct/hybrid.
 * Phase 4 Step 1 keeps this enabled — no production cutover.
 */
export function isStreamPlaybackForceProxy() {
  return envTruthy('STREAM_PLAYBACK_FORCE_PROXY', true)
}

export function shouldExposeDirectStreamUrlInApi() {
  const mode = getStreamDeliveryMode()
  if (!isDirectStreamSigningEnabled()) return false
  if (mode === 'proxy') return false
  return mode === 'hybrid' || mode === 'direct'
}

function streamHeaders(channel) {
  return {
    referer: String(channel?.referer || '').trim(),
    origin: String(channel?.origin || '').trim(),
    userAgent: String(channel?.userAgent || '').trim(),
  }
}

function buildProxyPlayback(req, upstreamUrl, hdr) {
  const proxy = buildPublicStreamProxyUrl(req, upstreamUrl, hdr)
  return proxy || upstreamUrl || ''
}

/**
 * Resolve playback + optional direct URL for one stream source.
 * @param {import('express').Request|null} req
 * @param {{ channelId?: string|number, upstreamUrl?: string, referer?: string, origin?: string, userAgent?: string }} channel
 */
export function resolveStreamSourceDelivery(req, channel) {
  const hdr = streamHeaders(channel)
  const upstream = String(channel?.upstreamUrl || channel?.url || '').trim()
  const mode = getStreamDeliveryMode()
  const forceProxy = isStreamPlaybackForceProxy()

  const proxyUrl = upstream ? buildProxyPlayback(req, upstream, hdr) : ''

  let directStreamUrl = ''
  if (shouldExposeDirectStreamUrlInApi() && upstream) {
    directStreamUrl = buildSignedDirectStreamPlaybackUrl(req, upstream, hdr, {
      channelId: channel?.channelId ?? channel?.id,
    })
  }

  let playbackUrl = proxyUrl
  let playbackSource = 'proxy'

  if (!forceProxy && mode === 'direct' && directStreamUrl) {
    playbackUrl = directStreamUrl
    playbackSource = 'direct'
  } else if (!forceProxy && mode === 'hybrid' && directStreamUrl) {
    // Future: prefer direct when health checks pass. Foundation: still proxy.
    playbackUrl = proxyUrl
    playbackSource = 'proxy'
  }

  return {
    mode,
    playbackUrl,
    playbackSource,
    directStreamUrl,
    proxyUrl,
    upstreamUrl: upstream,
    headers: hdr,
  }
}

/**
 * Channel-level delivery fields for GET /api/channels (additive + unchanged playback default).
 */
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
    direct_stream_url: primary.directStreamUrl || null,
    direct_stream_url_backup1: backup1.directStreamUrl || null,
    direct_stream_url_backup2: backup2.directStreamUrl || null,
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
    },
  }
}

export function getStreamDeliveryHealthSnapshot() {
  const mode = getStreamDeliveryMode()
  const signingEnabled = isDirectStreamSigningEnabled()
  const signingConfigured = isDirectStreamSigningConfigured()
  const forceProxy = isStreamPlaybackForceProxy()
  return {
    ok: signingEnabled ? signingConfigured : true,
    stream_delivery_mode: mode,
    signing_enabled: signingEnabled,
    signing_configured: signingConfigured,
    token_ttl_sec: getDirectStreamTokenTtlSec(),
    playback_force_proxy: forceProxy,
    production_cutover: !forceProxy && mode === 'direct',
    expose_direct_stream_url_in_api: shouldExposeDirectStreamUrlInApi(),
    routes: {
      proxy: `/${PROXY_MOUNT_STREAM}`,
      direct: `/${STREAM_DIRECT_MOUNT}`,
    },
    notes: forceProxy
      ? 'playbackUrl uses proxy; direct_stream_url is additive only (no cutover).'
      : 'STREAM_PLAYBACK_FORCE_PROXY=0 — direct mode may set playbackUrl to signed direct route.',
  }
}
