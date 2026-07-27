/** In-memory latest channel ref per device (verify/heartbeat updates; SSE ping reads). */
const hints = new Map()
const HINT_TTL_MS = 120_000

export function setLiveChannelHint(
  deviceId,
  { channelId = null, channelName = null, clearChannel = false } = {},
) {
  const d = String(deviceId ?? '').trim()
  if (!d) return
  if (clearChannel) {
    hints.set(d, { channelId: null, channelName: null, at: Date.now(), clearChannel: true })
    return
  }
  const cid = channelId ? String(channelId).trim() : null
  const cname = channelName ? String(channelName).trim() : null
  if (!cid && !cname) return
  hints.set(d, { channelId: cid, channelName: cname, at: Date.now(), clearChannel: false })
}

export function getLiveChannelHint(deviceId) {
  const d = String(deviceId ?? '').trim()
  if (!d) return null
  const h = hints.get(d)
  if (!h) return null
  if (Date.now() - h.at > HINT_TTL_MS) {
    hints.delete(d)
    return null
  }
  return h
}

export function clearLiveChannelHint(deviceId) {
  hints.delete(String(deviceId ?? '').trim())
}
