/**
 * HLS segment delivery via Bunny CDN (signed URLs) with selective proxy for protected providers.
 */
import crypto from 'node:crypto'
import {
  createStreamSegmentToken,
  getStreamSegmentTokenTtlSec,
  isDirectStreamSigningConfigured,
} from './directStreamSigning.js'
import { buildProxyUrl, PROXY_MOUNT_STREAM } from './streamManifestRewrite.js'
import {
  extractUrlHost,
  getProtectedProviderConfig,
  isProtectedSegmentTarget,
  isSelectiveSegmentRoutingEnabled,
} from './streamProtectedProviders.js'
import { getYcnUpstreamHeaderProfile } from './streamUpstreamHeaders.js'
import {
  recordSegmentDeliveryMode,
  recordSegmentProviderRoute,
  recordSegmentUrlIssued,
} from './streamDeliveryMetrics.js'
import { normalizeUpstreamHeaders } from './streamUpstreamHeaders.js'

export const STREAM_SEGMENT_MODES = Object.freeze(['proxy', 'bunny', 'hybrid'])
export const BUNNY_SEGMENT_PUBLIC_PATH = 'hls/seg'

function envTruthy(name, defaultVal = false) {
  const raw = process.env[name]
  if (raw === undefined || raw === null || String(raw).trim() === '') return defaultVal
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase())
}

export function getStreamSegmentDeliveryMode() {
  const raw = String(process.env.STREAM_SEGMENT_DELIVERY || 'bunny').trim().toLowerCase()
  return STREAM_SEGMENT_MODES.includes(raw) ? raw : 'bunny'
}

export function isStreamSegmentForceProxy() {
  return envTruthy('STREAM_SEGMENT_FORCE_PROXY', false)
}

export function getBunnyStreamCdnBaseUrl() {
  const stream = String(process.env.BUNNY_STREAM_CDN_BASE_URL || '').trim()
  if (stream) return stream.replace(/\/+$/, '')
  const shared = String(process.env.BUNNY_CDN_BASE_URL || '').trim()
  return shared ? shared.replace(/\/+$/, '') : ''
}

export function getBunnySegmentPublicPath() {
  const p = String(process.env.BUNNY_STREAM_SEGMENT_PATH || BUNNY_SEGMENT_PUBLIC_PATH).trim()
  return p.replace(/^\/+/, '').replace(/\/+$/, '') || BUNNY_SEGMENT_PUBLIC_PATH
}

export function isBunnySegmentDeliveryConfigured() {
  return Boolean(getBunnyStreamCdnBaseUrl()) && isDirectStreamSigningConfigured()
}

export function getStreamSegmentRolloutPercent() {
  const n = Number(process.env.STREAM_SEGMENT_ROLLOUT_PERCENT)
  if (!Number.isFinite(n)) return 100
  return Math.min(100, Math.max(0, Math.floor(n)))
}

function segmentRolloutSalt() {
  return String(process.env.STREAM_SEGMENT_ROLLOUT_SALT || 'osmani-seg-v1').trim()
}

function bucketEligibleForBunnySegment(sessionId, channelId) {
  const mode = getStreamSegmentDeliveryMode()
  if (mode === 'proxy' || isStreamSegmentForceProxy()) return false
  if (!isBunnySegmentDeliveryConfigured()) return false
  if (mode === 'bunny') return true
  const pct = getStreamSegmentRolloutPercent()
  if (pct >= 100) return true
  if (pct <= 0) return false
  const key = `${segmentRolloutSalt()}:${channelId || ''}:${sessionId || ''}`
  const hash = crypto.createHash('sha256').update(key).digest()
  const bucket = hash.readUInt32BE(0) % 100
  return bucket < pct
}

export function shouldDeliverSegmentsViaBunny(ctx = {}) {
  const mode = getStreamSegmentDeliveryMode()
  recordSegmentDeliveryMode(mode)
  if (isStreamSegmentForceProxy()) return false
  if (mode === 'proxy') return false
  if (!isBunnySegmentDeliveryConfigured()) return false
  if (mode === 'bunny') return true
  return bucketEligibleForBunnySegment(ctx.sessionId, ctx.channelId)
}

/**
 * Per-segment route: bunny (default) or proxy (protected providers).
 * @returns {'bunny'|'proxy'}
 */
export function resolveSegmentRoute(absoluteTarget, hdr = {}, ctx = {}) {
  if (isStreamSegmentForceProxy() || !shouldDeliverSegmentsViaBunny(ctx)) return 'proxy'
  if (!isSelectiveSegmentRoutingEnabled()) return 'bunny'

  const protectedCtx = {
    rootUpstreamUrl: ctx.rootUpstreamUrl,
    channelReferer: ctx.channelReferer || hdr.referer,
  }
  if (isProtectedSegmentTarget(absoluteTarget, hdr, protectedCtx)) return 'proxy'
  return 'bunny'
}

export function createManifestRewriteSession(channelId) {
  const cid = channelId != null ? String(channelId) : ''
  return crypto.randomBytes(12).toString('base64url')
}

export function buildSignedBunnySegmentUrl(absoluteTarget, hdr, meta = {}) {
  const signed = createStreamSegmentToken({
    upstreamUrl: absoluteTarget,
    referer: hdr.referer,
    origin: hdr.origin,
    userAgent: hdr.userAgent,
    channelId: meta.channelId,
    sessionId: meta.sessionId,
  })
  if (!signed.ok) return ''
  const cdn = getBunnyStreamCdnBaseUrl()
  if (!cdn) return ''
  const path = getBunnySegmentPublicPath()
  return `${cdn}/${path}?tok=${encodeURIComponent(signed.token)}`
}

/**
 * @param {import('express').Request} req
 * @param {{ channelId?: string, sessionId?: string, useBunny?: boolean, channelHeaders?: object, rootUpstreamUrl?: string }} ctx
 */
export function createManifestSegmentUrlBuilder(req, ctx = {}) {
  const channelId = ctx.channelId
  const sessionId = ctx.sessionId || createManifestRewriteSession(channelId)
  const rootUpstreamUrl = ctx.rootUpstreamUrl || ''
  const channelReferer = ctx.channelHeaders?.referer || ''
  const bunnyGloballyEnabled =
    ctx.useBunny !== undefined ? Boolean(ctx.useBunny) : shouldDeliverSegmentsViaBunny(ctx)
  const routeCtx = { channelId, sessionId, rootUpstreamUrl, channelReferer }

  const stats = { bunny: 0, proxy: 0 }

  return {
    sessionId,
    segmentDelivery: bunnyGloballyEnabled && isSelectiveSegmentRoutingEnabled() ? 'selective' : bunnyGloballyEnabled ? 'bunny' : 'proxy',
    buildTargetUrl(absoluteTarget, hdr) {
      let route = bunnyGloballyEnabled ? resolveSegmentRoute(absoluteTarget, hdr, routeCtx) : 'proxy'
      const host = extractUrlHost(absoluteTarget) || 'unknown'
      const protectedCtx = {
        rootUpstreamUrl: routeCtx.rootUpstreamUrl,
        channelReferer: routeCtx.channelReferer || hdr.referer,
      }
      if (route === 'bunny' && isProtectedSegmentTarget(absoluteTarget, hdr, protectedCtx)) {
        console.log(
          '[stream-segment]',
          JSON.stringify({
            scope: 'bunny_misroute',
            host,
            channel_id: channelId,
            session_id: sessionId,
            root_upstream_host: extractUrlHost(routeCtx.rootUpstreamUrl),
            segment_url: String(absoluteTarget || '').slice(0, 200),
            action: 'force_proxy',
          }),
        )
        route = 'proxy'
      }

      if (route === 'proxy') {
        recordSegmentUrlIssued('proxy')
        recordSegmentProviderRoute(host, 'proxy')
        stats.proxy += 1
        const proxyHdr = normalizeUpstreamHeaders(hdr, absoluteTarget)
        return buildProxyUrl(req, absoluteTarget, proxyHdr, PROXY_MOUNT_STREAM)
      }

      const bunny = buildSignedBunnySegmentUrl(absoluteTarget, hdr, { channelId, sessionId })
      if (bunny) {
        recordSegmentUrlIssued('bunny')
        recordSegmentProviderRoute(host, 'bunny')
        stats.bunny += 1
        return bunny
      }

      recordSegmentUrlIssued('proxy_fallback')
      recordSegmentProviderRoute(host, 'proxy')
      stats.proxy += 1
      const proxyHdr = normalizeUpstreamHeaders(hdr, absoluteTarget)
      return buildProxyUrl(req, absoluteTarget, proxyHdr, PROXY_MOUNT_STREAM)
    },
    getRouteStats: () => ({ ...stats }),
  }
}

export function resolveManifestRewriteUrlBuilder(req, ctx = {}) {
  const headers = ctx.channelHeaders || {}
  return createManifestSegmentUrlBuilder(req, {
    ...ctx,
    channelHeaders: headers,
    useBunny: shouldDeliverSegmentsViaBunny(ctx),
  })
}

export function getStreamSegmentDeliveryHealth() {
  const mode = getStreamSegmentDeliveryMode()
  const forceProxy = isStreamSegmentForceProxy()
  const bunnyConfigured = isBunnySegmentDeliveryConfigured()
  const selective = isSelectiveSegmentRoutingEnabled()
  const active =
    !forceProxy && mode !== 'proxy' && bunnyConfigured && (mode === 'bunny' || getStreamSegmentRolloutPercent() > 0)

  return {
    stream_segment_delivery: mode,
    stream_segment_force_proxy: forceProxy,
    selective_routing_enabled: selective,
    protected_providers: getProtectedProviderConfig(),
    bunny_stream_cdn_configured: bunnyConfigured,
    bunny_stream_cdn_base: getBunnyStreamCdnBaseUrl() || null,
    bunny_segment_public_path: getBunnySegmentPublicPath(),
    segment_token_ttl_sec: getStreamSegmentTokenTtlSec(),
    segment_rollout_percent: getStreamSegmentRolloutPercent(),
    production_segment_offload_active: active,
    client_path: active
      ? selective
        ? 'Public HLS → Bunny /hls/seg; protected providers (ycn-redirect, tokenized) → stream-proxy per segment'
        : 'Player → Bunny CDN → /hls/seg origin-pull on miss → upstream'
      : 'Player → Render stream-proxy (rollback / not enabled)',
    origin_pull_route: `/${getBunnySegmentPublicPath()}`,
    ycn_upstream_profile: getYcnUpstreamHeaderProfile(),
  }
}

export function getBunnyOriginCacheMaxAgeSec() {
  return Math.max(60, Number(process.env.BUNNY_SEGMENT_CACHE_MAX_AGE_SEC) || 86_400)
}

export function isBunnyOriginAuthRequired() {
  return String(process.env.BUNNY_PULL_ORIGIN_SECRET || '').trim().length > 0
}

export function verifyBunnyOriginRequest(req) {
  const secret = String(process.env.BUNNY_PULL_ORIGIN_SECRET || '').trim()
  if (!secret) return { ok: true }
  const header =
    String(req.headers['x-bunny-origin-auth'] || req.headers['x-osmani-bunny-origin'] || '').trim()
  if (header && header === secret) return { ok: true }
  return { ok: false, error: 'Origin auth required', status: 403 }
}
