/** Shared presence field parsing for analytics + legacy subscription routes. */

function parseText(v) {
  const s = String(v ?? '').trim()
  return s || null
}

export function parseChannelIdFromPayload(source) {
  if (!source || typeof source !== 'object') return null
  return parseText(
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
      source.channel,
  )
}

export function parseChannelIdFromRequest(req) {
  const q = req?.query && typeof req.query === 'object' ? req.query : {}
  const b = req?.body && typeof req.body === 'object' ? req.body : {}
  return parseChannelIdFromPayload(q) || parseChannelIdFromPayload(b)
}

/** Top 5 widget minimum concurrent viewers (default 10). */
export const TOP5_MIN_VIEWERS = Math.max(
  1,
  Math.min(100, Math.trunc(Number(process.env.ANALYTICS_TOP5_MIN_VIEWERS) || 10)),
)
