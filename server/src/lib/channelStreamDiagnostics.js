import crypto from 'node:crypto'

/**
 * IPTV / HLS channel delivery diagnostics for /api/channels.
 * Enable with CHANNEL_STREAM_DIAG=1 (never enables by default).
 *
 * CHANNEL_STREAM_DIAG_MATCH — substring (case-insensitive) to pick channels to log; empty = all channels (noisy).
 *   Default: ycn-redirect (covers het103b.ycn-redirect.com style URLs).
 * CHANNEL_STREAM_DIAG_FULL_URLS=1 — log complete url fields (tokens visible in logs).
 */

function envTruthy(k) {
  const v = String(process.env[k] ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

export function channelStreamDiagEnabled() {
  return envTruthy('CHANNEL_STREAM_DIAG')
}

function matchSubstring() {
  const raw = process.env.CHANNEL_STREAM_DIAG_MATCH
  if (raw === undefined || raw === null) return 'ycn-redirect'
  const s = String(raw).trim()
  return s
}

export function channelMatchesStreamDiag(url) {
  if (!channelStreamDiagEnabled()) return false
  const needle = matchSubstring()
  if (!needle) return true
  return String(url ?? '').toLowerCase().includes(needle.toLowerCase())
}

function maybeTruncate(label, value, fullUrls) {
  const s = String(value ?? '')
  if (fullUrls || s.length <= 200) return { [label]: s, [`${label}_length`]: s.length }
  return {
    [`${label}_length`]: s.length,
    [`${label}_head`]: s.slice(0, 100),
    [`${label}_tail`]: s.slice(-80),
  }
}

function hashJson(obj) {
  const json = JSON.stringify(obj)
  return {
    json_byte_length: Buffer.byteLength(json, 'utf8'),
    json_sha256_hex: crypto.createHash('sha256').update(json).digest('hex'),
  }
}

/**
 * @param {object} rawFromDb — channel row from store.readChannels() before migrateStoredChannel
 * @param {object} apiShape — object returned by channelToResponse(rawFromDb, req)
 */
export function logChannelStreamDiagGet(rawFromDb, apiShape, meta = {}) {
  if (!channelStreamDiagEnabled() || !channelMatchesStreamDiag(rawFromDb?.url)) return

  const fullUrls = envTruthy('CHANNEL_STREAM_DIAG_FULL_URLS')
  const storedUrl = String(rawFromDb?.url ?? '')
  const outUrl = String(apiShape?.url ?? '')
  const b1s = String(rawFromDb?.backupStream1 ?? '')
  const b1o = String(apiShape?.backupStream1 ?? '')
  const b2s = String(rawFromDb?.backupStream2 ?? '')
  const b2o = String(apiShape?.backupStream2 ?? '')

  const headersOut = {
    origin: String(apiShape?.origin ?? ''),
    referer: String(apiShape?.referer ?? ''),
    userAgent: String(apiShape?.userAgent ?? ''),
  }

  const payload = {
    scope: 'channels.GET_item',
    channelId: rawFromDb?.id,
    ...meta,
    url_strict_equal_stored_vs_json: storedUrl === outUrl,
    url_equal_if_trim_stored: storedUrl.trim() === outUrl,
    url_encoding_note:
      'express res.json uses JSON.stringify; &, ?, = in strings are not percent-encoded again',
    ...maybeTruncate('url_stored_raw', storedUrl, fullUrls),
    ...maybeTruncate('url_api_response', outUrl, fullUrls),
    backup1_strict_equal: b1s === b1o,
    backup2_strict_equal: b2s === b2o,
    headers_out_exact: headersOut,
    ...hashJson(apiShape),
  }

  console.log('[channel-stream-diag]', JSON.stringify(payload))
}

/** Log full list integrity (order + aggregate hash). */
export function logChannelStreamDiagList(apiArray, meta = {}) {
  if (!channelStreamDiagEnabled()) return
  const needle = matchSubstring()
  const relevant = needle
    ? apiArray.filter((c) => String(c?.url ?? '').toLowerCase().includes(needle.toLowerCase()))
    : apiArray

  if (relevant.length === 0 && needle) {
    console.log(
      '[channel-stream-diag]',
      JSON.stringify({
        scope: 'channels.GET_list',
        ...meta,
        match: needle,
        matched_channels: 0,
        note: 'No channel URLs matched CHANNEL_STREAM_DIAG_MATCH; enable CHANNEL_STREAM_DIAG_MATCH= for broader logs',
      }),
    )
    return
  }

  const slice = needle ? relevant : apiArray
  const payload = {
    scope: 'channels.GET_list',
    ...meta,
    channel_count: apiArray.length,
    logged_subset_count: slice.length,
    match_substring: needle || '(all)',
    list_subset_sha256: crypto.createHash('sha256').update(JSON.stringify(slice)).digest('hex'),
    list_total_json_sha256: crypto.createHash('sha256').update(JSON.stringify(apiArray)).digest('hex'),
  }
  console.log('[channel-stream-diag]', JSON.stringify(payload))
}

export function logChannelStreamDiagWrite(responseShape, meta = {}) {
  if (!channelStreamDiagEnabled() || !channelMatchesStreamDiag(responseShape?.url)) return
  const fullUrls = envTruthy('CHANNEL_STREAM_DIAG_FULL_URLS')
  const payload = {
    scope: meta.scope || 'channels_WRITE_response',
    channelId: responseShape?.id,
    ...meta,
    headers_out_exact: {
      origin: String(responseShape?.origin ?? ''),
      referer: String(responseShape?.referer ?? ''),
      userAgent: String(responseShape?.userAgent ?? ''),
    },
    ...maybeTruncate('url_api_response', responseShape?.url, fullUrls),
    ...hashJson(responseShape),
  }
  console.log('[channel-stream-diag]', JSON.stringify(payload))
}
