import crypto from 'node:crypto'
import { defaultPublicApiOrigin } from './deployMeta.js'
import { isBunnyCdnHost } from './cdnAssets.js'
import { recordTokenValidationFailure } from './streamDeliveryMetrics.js'
import { normalizeUpstreamHeaders } from './streamUpstreamHeaders.js'

export const STREAM_DIRECT_MOUNT = 'stream-direct'

const DEFAULT_STREAM_API_BASE = defaultPublicApiOrigin()

function parseStreamApiBaseUrl(raw) {
  const s = String(raw || '').trim().replace(/\/+$/, '')
  if (!s) return ''
  try {
    const u = new URL(s.includes('://') ? s : `https://${s}`)
    if (isBunnyCdnHost(u.hostname)) return ''
    return `${u.protocol}//${u.host}`
  } catch {
    return ''
  }
}

function resolveRequestStreamApiBase(req) {
  if (!req) return ''
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0]
  const host = String(req.headers['x-forwarded-host'] || req.get('host') || '')
    .split(',')[0]
    .trim()
  if (!host || isBunnyCdnHost(host)) return ''
  return `${proto}://${host}`.replace(/\/+$/, '')
}

function envStreamBaseMatchesRequest(envBase, requestBase) {
  if (!envBase || !requestBase) return true
  try {
    return new URL(envBase).host === new URL(requestBase).host
  } catch {
    return true
  }
}

/**
 * API origin for stream-direct / stream-proxy entrypoints.
 * Never use Bunny CDN pull zones — manifests and tokens are served only from the API host.
 * When STREAM_API_BASE_URL points at another deployment (e.g. Contabo IP on Render), prefer the request host
 * so legacy Render APK clients keep same-origin HTTPS playback URLs.
 */
export function resolveStreamApiBaseUrl(req) {
  const requestBase = resolveRequestStreamApiBase(req)
  for (const raw of [
    process.env.STREAM_API_BASE_URL,
    process.env.DIRECT_STREAM_BASE_URL,
    process.env.BASE_URL,
  ]) {
    const parsed = parseStreamApiBaseUrl(raw)
    if (!parsed) continue
    if (requestBase && !envStreamBaseMatchesRequest(parsed, requestBase)) continue
    return parsed
  }
  if (requestBase) return requestBase
  return DEFAULT_STREAM_API_BASE
}

const DEFAULT_TOKEN_TTL_SEC = Math.min(
  900,
  Math.max(30, Number(process.env.DIRECT_STREAM_TOKEN_TTL_SEC) || 120),
)

const DEFAULT_SEGMENT_TOKEN_TTL_SEC = Math.min(
  3600,
  Math.max(60, Number(process.env.STREAM_SEGMENT_TOKEN_TTL_SEC) || 600),
)

function base64UrlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function base64UrlDecode(str) {
  const pad = '='.repeat((4 - (String(str).length % 4)) % 4)
  const b64 = String(str).replace(/-/g, '+').replace(/_/g, '/') + pad
  return Buffer.from(b64, 'base64')
}

function signingSecret() {
  return String(
    process.env.DIRECT_STREAM_SIGNING_SECRET || process.env.STREAM_SIGNING_SECRET || '',
  ).trim()
}

export function isDirectStreamSigningEnabled() {
  const raw = String(process.env.DIRECT_STREAM_SIGNING_ENABLED ?? '0').trim().toLowerCase()
  return ['1', 'true', 'yes', 'on'].includes(raw)
}

export function isDirectStreamSigningConfigured() {
  return isDirectStreamSigningEnabled() && signingSecret().length >= 16
}

export function getDirectStreamTokenTtlSec() {
  return DEFAULT_TOKEN_TTL_SEC
}

export function getStreamSegmentTokenTtlSec() {
  return DEFAULT_SEGMENT_TOKEN_TTL_SEC
}

function parseUpstreamUrl(raw) {
  const u = String(raw || '').trim()
  if (!u) return null
  try {
    const parsed = new URL(u)
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
    return parsed.toString()
  } catch {
    return null
  }
}

/**
 * @param {object} input
 * @param {string} input.upstreamUrl
 * @param {string} [input.referer]
 * @param {string} [input.origin]
 * @param {string} [input.userAgent]
 * @param {string|number} [input.channelId]
 * @param {number} [input.ttlSec]
 */
export function createDirectStreamToken(input) {
  if (!isDirectStreamSigningConfigured()) {
    return { ok: false, error: 'Direct stream signing is not configured' }
  }
  const upstreamUrl = parseUpstreamUrl(input?.upstreamUrl)
  if (!upstreamUrl) {
    return { ok: false, error: 'Invalid upstream URL' }
  }
  const hdr = normalizeUpstreamHeaders(
    {
      referer: input?.referer,
      origin: input?.origin,
      userAgent: input?.userAgent,
    },
    upstreamUrl,
  )
  const ttlSec = Math.min(900, Math.max(30, Number(input?.ttlSec) || DEFAULT_TOKEN_TTL_SEC))
  const exp = Math.floor(Date.now() / 1000) + ttlSec
  const payload = {
    v: 1,
    u: upstreamUrl,
    r: hdr.referer,
    o: hdr.origin,
    ua: hdr.userAgent,
    cid: input?.channelId != null ? String(input.channelId) : '',
    exp,
  }
  const body = base64UrlEncode(JSON.stringify(payload))
  const sig = crypto.createHmac('sha256', signingSecret()).update(body).digest('base64url')
  return { ok: true, token: `${body}.${sig}`, exp, ttlSec }
}

/**
 * @returns {{ ok: true, payload: object } | { ok: false, error: string, status: number }}
 */
export function verifyDirectStreamToken(token) {
  const verified = verifySignedTokenBody(token, null)
  if (!verified.ok) return verified
  if (verified.payload.tokenType === 'seg') {
    const err = { ok: false, error: 'Manifest token required', status: 400 }
    recordTokenValidationFailure(err.error)
    return err
  }
  return verified
}

export function resolveStreamDirectBaseUrl(req) {
  return resolveStreamApiBaseUrl(req)
}

/**
 * Signed playback entrypoint (validates token server-side; not raw upstream in API).
 */
function verifySignedTokenBody(raw, expectedType) {
  if (!isDirectStreamSigningConfigured()) {
    const err = { ok: false, error: 'Signing not configured', status: 503 }
    recordTokenValidationFailure(err.error)
    return err
  }
  const token = String(raw || '').trim()
  const dot = token.lastIndexOf('.')
  if (dot <= 0) {
    const err = { ok: false, error: 'Malformed token', status: 400 }
    recordTokenValidationFailure(err.error)
    return err
  }
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = crypto.createHmac('sha256', signingSecret()).update(body).digest('base64url')
  const sigBuf = Buffer.from(sig)
  const expBuf = Buffer.from(expected)
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    const err = { ok: false, error: 'Invalid signature', status: 403 }
    recordTokenValidationFailure(err.error)
    return err
  }
  let payload
  try {
    payload = JSON.parse(base64UrlDecode(body).toString('utf8'))
  } catch {
    const err = { ok: false, error: 'Invalid token payload', status: 400 }
    recordTokenValidationFailure(err.error)
    return err
  }
  const tokenType = payload.t || 'man'
  if (expectedType && tokenType !== expectedType) {
    const err = { ok: false, error: 'Invalid token type', status: 400 }
    recordTokenValidationFailure(err.error)
    return err
  }
  const version = Number(payload.v)
  if (!payload || (version !== 1 && version !== 2) || !payload.u) {
    const err = { ok: false, error: 'Unsupported token version', status: 400 }
    recordTokenValidationFailure(err.error)
    return err
  }
  const exp = Number(payload.exp)
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
    const err = { ok: false, error: 'Token expired', status: 403 }
    recordTokenValidationFailure(err.error)
    return err
  }
  const upstreamUrl = parseUpstreamUrl(payload.u)
  if (!upstreamUrl) {
    const err = { ok: false, error: 'Invalid upstream in token', status: 400 }
    recordTokenValidationFailure(err.error)
    return err
  }
  const hdr = normalizeUpstreamHeaders(
    {
      referer: payload.r,
      origin: payload.o,
      userAgent: payload.ua,
    },
    upstreamUrl,
  )
  return {
    ok: true,
    payload: {
      upstreamUrl,
      referer: hdr.referer,
      origin: hdr.origin,
      userAgent: hdr.userAgent,
      channelId: String(payload.cid || ''),
      sessionId: String(payload.sid || ''),
      exp,
      tokenType,
      version,
    },
  }
}

/**
 * HLS segment token (v2, type seg) — used in Bunny CDN URLs; never exposes raw upstream in manifest.
 */
export function createStreamSegmentToken(input) {
  if (!isDirectStreamSigningConfigured()) {
    return { ok: false, error: 'Direct stream signing is not configured' }
  }
  const upstreamUrl = parseUpstreamUrl(input?.upstreamUrl)
  if (!upstreamUrl) {
    return { ok: false, error: 'Invalid upstream URL' }
  }
  const hdr = normalizeUpstreamHeaders(
    {
      referer: input?.referer,
      origin: input?.origin,
      userAgent: input?.userAgent,
    },
    upstreamUrl,
  )
  const ttlSec = Math.min(
    3600,
    Math.max(60, Number(input?.ttlSec) || DEFAULT_SEGMENT_TOKEN_TTL_SEC),
  )
  const exp = Math.floor(Date.now() / 1000) + ttlSec
  const payload = {
    v: 2,
    t: 'seg',
    u: upstreamUrl,
    r: hdr.referer,
    o: hdr.origin,
    ua: hdr.userAgent,
    cid: input?.channelId != null ? String(input.channelId) : '',
    sid: String(input?.sessionId || '').trim(),
    exp,
  }
  const body = base64UrlEncode(JSON.stringify(payload))
  const sig = crypto.createHmac('sha256', signingSecret()).update(body).digest('base64url')
  return { ok: true, token: `${body}.${sig}`, exp, ttlSec }
}

export function verifyStreamSegmentToken(token) {
  return verifySignedTokenBody(token, 'seg')
}

export function buildSignedDirectStreamPlaybackUrl(req, upstreamUrl, hdr = {}, meta = {}) {
  const signed = createDirectStreamToken({
    upstreamUrl,
    referer: hdr.referer,
    origin: hdr.origin,
    userAgent: hdr.userAgent,
    channelId: meta.channelId,
  })
  if (!signed.ok) return ''
  const base = resolveStreamDirectBaseUrl(req)
  if (!base) return ''
  return `${base}/${STREAM_DIRECT_MOUNT}?token=${encodeURIComponent(signed.token)}`
}
