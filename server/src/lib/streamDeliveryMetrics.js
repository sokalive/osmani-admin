/**
 * In-process counters for direct vs proxy stream delivery (resets on deploy/restart).
 */

const counters = {
  playback_assigned_direct: 0,
  playback_assigned_proxy: 0,
  direct_requests: 0,
  direct_manifest_ok: 0,
  direct_upstream_error: 0,
  direct_fetch_error: 0,
  proxy_requests: 0,
  proxy_manifest_ok: 0,
  proxy_upstream_error: 0,
  token_invalid_signature: 0,
  token_malformed: 0,
  token_expired: 0,
  token_not_configured: 0,
  token_other: 0,
  client_fallback_reported: 0,
  segment_urls_bunny: 0,
  segment_urls_proxy: 0,
  segment_urls_proxy_fallback: 0,
  bunny_origin_fetch_ok: 0,
  bunny_origin_fetch_upstream_error: 0,
  bunny_origin_fetch_fetch_error: 0,
  bunny_origin_fetch_token_invalid: 0,
  bunny_origin_fetch_origin_auth_denied: 0,
  client_segment_cdn_ok: 0,
  client_segment_cdn_fail: 0,
  client_segment_proxy_fallback: 0,
}

/** @type {Map<string, { bunny: number, proxy: number }>} */
const segmentRoutesByProvider = new Map()

function inc(key, n = 1) {
  if (!Object.prototype.hasOwnProperty.call(counters, key)) return
  counters[key] += n
}

export function recordPlaybackAssigned(source) {
  if (source === 'direct') inc('playback_assigned_direct')
  else inc('playback_assigned_proxy')
}

export function recordProxyRequest(outcome) {
  inc('proxy_requests')
  if (outcome === 'manifest_ok') inc('proxy_manifest_ok')
  if (outcome === 'upstream_error') inc('proxy_upstream_error')
}

export function recordDirectRequest(outcome) {
  inc('direct_requests')
  if (outcome === 'manifest_ok') inc('direct_manifest_ok')
  if (outcome === 'upstream_error') inc('direct_upstream_error')
  if (outcome === 'fetch_error') inc('direct_fetch_error')
}

export function recordTokenValidationFailure(reason) {
  const r = String(reason || '').toLowerCase()
  if (r.includes('expired')) inc('token_expired')
  else if (r.includes('signature')) inc('token_invalid_signature')
  else if (r.includes('malformed') || r.includes('payload')) inc('token_malformed')
  else if (r.includes('not configured')) inc('token_not_configured')
  else inc('token_other')
}

export function recordClientFallbackReported() {
  inc('client_fallback_reported')
}

export function recordSegmentUrlIssued(kind) {
  if (kind === 'bunny') inc('segment_urls_bunny')
  else if (kind === 'proxy_fallback') inc('segment_urls_proxy_fallback')
  else inc('segment_urls_proxy')
}

export function recordSegmentDeliveryMode(_mode) {
  /* reserved for future per-mode gauges */
}

export function recordSegmentProviderRoute(providerHost, route) {
  const host = String(providerHost || 'unknown').toLowerCase() || 'unknown'
  const key = route === 'bunny' ? 'bunny' : 'proxy'
  const row = segmentRoutesByProvider.get(host) || { bunny: 0, proxy: 0 }
  row[key] += 1
  segmentRoutesByProvider.set(host, row)
}

export function getSegmentRoutesByProviderSnapshot() {
  const out = {}
  for (const [host, counts] of segmentRoutesByProvider) {
    out[host] = { ...counts, total: counts.bunny + counts.proxy }
  }
  return out
}

export function recordBunnyOriginFetch(outcome) {
  if (outcome === 'ok') inc('bunny_origin_fetch_ok')
  else if (outcome === 'upstream_error') inc('bunny_origin_fetch_upstream_error')
  else if (outcome === 'fetch_error') inc('bunny_origin_fetch_fetch_error')
  else if (outcome === 'token_invalid') inc('bunny_origin_fetch_token_invalid')
  else if (outcome === 'origin_auth_denied') inc('bunny_origin_fetch_origin_auth_denied')
}

export function recordClientSegmentReport(outcome) {
  const o = String(outcome || '').toLowerCase()
  if (o === 'cdn_ok' || o === 'bunny_ok') inc('client_segment_cdn_ok')
  else if (o === 'cdn_fail' || o === 'bunny_fail') inc('client_segment_cdn_fail')
  else if (o === 'proxy_fallback' || o === 'fallback_proxy') inc('client_segment_proxy_fallback')
}

export function getStreamDeliveryMetricsSnapshot() {
  const token_failures =
    counters.token_invalid_signature +
    counters.token_malformed +
    counters.token_expired +
    counters.token_not_configured +
    counters.token_other

  const bunny_origin_failures =
    counters.bunny_origin_fetch_upstream_error +
    counters.bunny_origin_fetch_fetch_error +
    counters.bunny_origin_fetch_token_invalid +
    counters.bunny_origin_fetch_origin_auth_denied

  return {
    ...counters,
    token_failures_total: token_failures,
    direct_success_total: counters.direct_manifest_ok,
    direct_failure_total: counters.direct_upstream_error + counters.direct_fetch_error,
    proxy_fallback_reports: counters.client_fallback_reported,
    segment_urls_total:
      counters.segment_urls_bunny +
      counters.segment_urls_proxy +
      counters.segment_urls_proxy_fallback,
    bunny_origin_success_total: counters.bunny_origin_fetch_ok,
    bunny_origin_failure_total: bunny_origin_failures,
    client_segment_reports_total:
      counters.client_segment_cdn_ok +
      counters.client_segment_cdn_fail +
      counters.client_segment_proxy_fallback,
    segment_routes_by_provider: getSegmentRoutesByProviderSnapshot(),
  }
}

export function resetStreamDeliveryMetrics() {
  for (const k of Object.keys(counters)) counters[k] = 0
  segmentRoutesByProvider.clear()
}
