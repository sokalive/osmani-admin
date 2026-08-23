/**
 * Short-lived server-issued playback grants.
 * Bound to device_id (+ optional channel_id). Not a client premium flag.
 */
import crypto from 'node:crypto'

function signingSecret() {
  return String(
    process.env.PLAYBACK_GRANT_SIGNING_SECRET ||
      process.env.DIRECT_STREAM_SIGNING_SECRET ||
      process.env.STREAM_SIGNING_SECRET ||
      process.env.ADMIN_API_TOKEN ||
      '',
  ).trim()
}

export function playbackGrantTtlSec() {
  return Math.min(900, Math.max(30, Number(process.env.PLAYBACK_GRANT_TTL_SEC) || 180))
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function b64urlDecode(str) {
  const pad = '='.repeat((4 - (String(str).length % 4)) % 4)
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
}

export function isPlaybackGrantConfigured() {
  return signingSecret().length >= 8
}

/**
 * @param {{ deviceId: string, channelId?: string|number, reason?: string, ttlSec?: number }} input
 */
export function createPlaybackGrant(input) {
  const secret = signingSecret()
  if (secret.length < 8) {
    return { ok: false, error: 'Playback grant signing not configured' }
  }
  const deviceId = String(input?.deviceId || '').trim().slice(0, 128)
  if (!deviceId) return { ok: false, error: 'device_id required' }

  const ttlSec = Math.min(900, Math.max(30, Number(input?.ttlSec) || playbackGrantTtlSec()))
  const exp = Math.floor(Date.now() / 1000) + ttlSec
  const payload = {
    v: 1,
    t: 'playback_grant',
    did: deviceId,
    cid: input?.channelId != null ? String(input.channelId) : '',
    reason: String(input?.reason || 'active_subscription').slice(0, 64),
    jti: crypto.randomBytes(12).toString('hex'),
    exp,
  }
  const body = b64url(JSON.stringify(payload))
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url')
  return {
    ok: true,
    grant: `${body}.${sig}`,
    exp,
    expires_at: new Date(exp * 1000).toISOString(),
    ttl_sec: ttlSec,
    device_id: deviceId,
    channel_id: payload.cid || null,
  }
}

/**
 * @returns {{ ok: true, payload: object } | { ok: false, error: string, code: string }}
 */
export function verifyPlaybackGrant(token, opts = {}) {
  const secret = signingSecret()
  if (secret.length < 8) {
    return { ok: false, error: 'Playback grant signing not configured', code: 'grant_unavailable' }
  }
  const raw = String(token || '').trim()
  const dot = raw.lastIndexOf('.')
  if (dot <= 0) {
    return { ok: false, error: 'Malformed playback grant', code: 'stale_or_invalid_playback_authorization' }
  }
  const body = raw.slice(0, dot)
  const sig = raw.slice(dot + 1)
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: 'Invalid playback grant signature', code: 'stale_or_invalid_playback_authorization' }
  }
  let payload
  try {
    payload = JSON.parse(b64urlDecode(body).toString('utf8'))
  } catch {
    return { ok: false, error: 'Invalid playback grant payload', code: 'stale_or_invalid_playback_authorization' }
  }
  if (!payload || payload.t !== 'playback_grant' || Number(payload.v) !== 1) {
    return { ok: false, error: 'Unsupported playback grant', code: 'stale_or_invalid_playback_authorization' }
  }
  const exp = Number(payload.exp)
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, error: 'Playback grant expired', code: 'stale_or_invalid_playback_authorization' }
  }
  const deviceId = String(payload.did || '').trim()
  if (!deviceId) {
    return { ok: false, error: 'Playback grant missing device', code: 'stale_or_invalid_playback_authorization' }
  }
  if (opts.expectedDeviceId && String(opts.expectedDeviceId).trim() !== deviceId) {
    return { ok: false, error: 'Playback grant device mismatch', code: 'stale_or_invalid_playback_authorization' }
  }
  if (
    opts.expectedChannelId != null &&
    payload.cid &&
    String(opts.expectedChannelId) !== String(payload.cid)
  ) {
    return { ok: false, error: 'Playback grant channel mismatch', code: 'stale_or_invalid_playback_authorization' }
  }
  return {
    ok: true,
    payload: {
      device_id: deviceId,
      channel_id: payload.cid || '',
      reason: payload.reason || '',
      jti: payload.jti || '',
      exp,
    },
  }
}
