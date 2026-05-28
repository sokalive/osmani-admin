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
}

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

export function getStreamDeliveryMetricsSnapshot() {
  const token_failures =
    counters.token_invalid_signature +
    counters.token_malformed +
    counters.token_expired +
    counters.token_not_configured +
    counters.token_other

  return {
    ...counters,
    token_failures_total: token_failures,
    direct_success_total: counters.direct_manifest_ok,
    direct_failure_total: counters.direct_upstream_error + counters.direct_fetch_error,
    proxy_fallback_reports: counters.client_fallback_reported,
  }
}

export function resetStreamDeliveryMetrics() {
  for (const k of Object.keys(counters)) counters[k] = 0
}
