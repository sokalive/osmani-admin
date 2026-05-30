/**
 * Notification tap destination — stored in payload + target_type for runtime clients.
 */

export const DESTINATION_TYPES = new Set(['home', 'channel', 'custom'])

export function channelDeepLink(channelId) {
  const id = Number(channelId)
  if (!Number.isFinite(id) || id <= 0) return null
  return `osmani://channel/${Math.trunc(id)}`
}

export function buildNotificationDestination(input = {}) {
  const raw = input && typeof input === 'object' ? input : {}
  const nested = raw.destination && typeof raw.destination === 'object' ? raw.destination : raw
  let type = String(nested.type ?? nested.destinationType ?? 'home')
    .trim()
    .toLowerCase()
  if (!DESTINATION_TYPES.has(type)) type = 'home'

  const channelIdRaw = nested.channelId ?? nested.channel_id
  const channelId =
    channelIdRaw != null && channelIdRaw !== '' && Number.isFinite(Number(channelIdRaw))
      ? Math.trunc(Number(channelIdRaw))
      : null
  const channelName = String(nested.channelName ?? nested.channel_name ?? '').trim().slice(0, 200)

  let deepLink = 'osmani://home'
  if (type === 'home') {
    deepLink = 'osmani://home'
  } else if (type === 'channel') {
    if (!channelId) throw new Error('channelId is required when destination is channel')
    deepLink = channelDeepLink(channelId)
  } else {
    const custom = String(
      nested.deepLink ?? nested.customDeepLink ?? nested.custom_deep_link ?? raw.targetType ?? raw.target_type ?? '',
    ).trim()
    if (!custom) throw new Error('Custom deep link is required when destination is custom')
    deepLink = custom.slice(0, 512)
  }

  return {
    type,
    channelId: type === 'channel' ? channelId : null,
    channelName: type === 'channel' ? channelName : null,
    deepLink,
  }
}

export function mergeDestinationIntoPayload(payload, destination) {
  const base = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
  return { ...base, destination }
}

export function destinationFromPayloadAndTargetType(payload, targetType) {
  const p = payload && typeof payload === 'object' ? payload : {}
  if (p.destination && typeof p.destination === 'object' && p.destination.type) {
    return {
      type: String(p.destination.type),
      channelId: p.destination.channelId ?? p.destination.channel_id ?? null,
      channelName: p.destination.channelName ?? p.destination.channel_name ?? null,
      deepLink: String(p.destination.deepLink ?? targetType ?? 'osmani://home'),
    }
  }
  const link = String(targetType ?? '').trim() || 'osmani://home'
  if (link === 'osmani://home') {
    return { type: 'home', channelId: null, channelName: null, deepLink: link }
  }
  const channelMatch = /^osmani:\/\/channel\/(\d+)$/i.exec(link)
  if (channelMatch) {
    return {
      type: 'channel',
      channelId: Number(channelMatch[1]),
      channelName: null,
      deepLink: link,
    }
  }
  return { type: 'custom', channelId: null, channelName: null, deepLink: link }
}

/** Flat string map for optional OneSignal `data` (additive; clients may ignore). */
export function oneSignalDataFromDestination(destination) {
  if (!destination?.deepLink) return undefined
  const data = {
    target_type: String(destination.deepLink).slice(0, 512),
    destination_type: String(destination.type || 'home').slice(0, 32),
  }
  if (destination.channelId != null) data.channel_id = String(destination.channelId)
  if (destination.channelName) data.channel_name = String(destination.channelName).slice(0, 120)
  return data
}
