/** Shared presence field parsing for analytics + legacy subscription routes. */

function parseText(v) {
  const s = String(v ?? '').trim()
  return s || null
}

function channelIdFromNested(value) {
  if (value == null) return null
  if (typeof value === 'number' && Number.isFinite(value)) return parseText(value)
  if (typeof value === 'string') return parseText(value)
  if (typeof value !== 'object') return null
  return (
    parseText(
      value.id ??
        value.channel_id ??
        value.channelId ??
        value.active_channel_id ??
        value.activeChannelId,
    ) ||
    parseText(value.name ?? value.channel_name ?? value.channelName)
  )
}

export function parseChannelNameFromPayload(source) {
  if (!source || typeof source !== 'object') return null
  const direct = parseText(
    source.channel_name ??
      source.channelName ??
      source.watching_channel_name ??
      source.watchingChannelName,
  )
  if (direct) return direct
  const ch = source.channel
  if (ch && typeof ch === 'object') {
    return parseText(ch.name ?? ch.channel_name ?? ch.channelName)
  }
  return null
}

export function parseChannelRefFromPayload(source) {
  return {
    channelId: parseChannelIdFromPayload(source),
    channelName: parseChannelNameFromPayload(source),
  }
}

export function parseChannelIdFromPayload(source) {
  if (!source || typeof source !== 'object') return null
  const direct = parseText(
    source.channel_id ??
      source.channelId ??
      source.active_channel_id ??
      source.activeChannelId ??
      source.stream_channel_id ??
      source.streamChannelId ??
      source.watching_channel_id ??
      source.watchingChannelId ??
      source.current_channel_id ??
      source.currentChannelId ??
      source.stream_id ??
      source.streamId ??
      source.selected_channel_id ??
      source.selectedChannelId ??
      source.playing_channel_id ??
      source.playingChannelId,
  )
  if (direct) return direct
  return channelIdFromNested(source.channel)
}

export function parseChannelIdFromRequest(req) {
  const q = req?.query && typeof req.query === 'object' ? req.query : {}
  const b = req?.body && typeof req.body === 'object' ? req.body : {}
  const headers = req?.headers && typeof req.headers === 'object' ? req.headers : {}
  const fromHeader = parseText(
    headers['x-channel-id'] ??
      headers['x-active-channel-id'] ??
      headers['x-watching-channel-id'],
  )
  return (
    fromHeader ||
    parseChannelIdFromPayload(q) ||
    parseChannelIdFromPayload(b) ||
    parseChannelIdFromPayload(headers)
  )
}

export function parseChannelRefFromRequest(req) {
  const q = req?.query && typeof req.query === 'object' ? req.query : {}
  const b = req?.body && typeof req.body === 'object' ? req.body : {}
  const merged = { ...q, ...b }
  const ref = parseChannelRefFromPayload(merged)
  if (!ref.channelId && !ref.channelName) {
    const hId = parseChannelIdFromRequest(req)
    if (hId) ref.channelId = hId
  }
  return ref
}

/** Top 5 widget minimum concurrent viewers (default 10). */
export const TOP5_MIN_VIEWERS = Math.max(
  1,
  Math.min(100, Math.trunc(Number(process.env.ANALYTICS_TOP5_MIN_VIEWERS) || 10)),
)

/** True when client explicitly signals playback stopped (clears stale channel_id). */
export function parseChannelClearFromPayload(source) {
  if (!source || typeof source !== 'object') return false
  if (source.watching === false || source.is_watching === false || source.isWatching === false) {
    return true
  }
  if (
    source.playback_active === false ||
    source.playbackActive === false ||
    source.playing === false ||
    source.is_playing === false ||
    source.isPlaying === false
  ) {
    return true
  }
  if ('channel_id' in source && (source.channel_id === null || source.channel_id === '')) {
    return true
  }
  if ('channelId' in source && (source.channelId === null || source.channelId === '')) {
    return true
  }
  return false
}
