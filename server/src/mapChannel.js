import { bodyToInsert } from './normalizeBody.js'

/** Stored channel object (same shape as API / frontend expects) */
export function storedChannelFromBody(body, id, createdAt, updatedAt) {
  const b = bodyToInsert(body)
  return {
    id,
    name: b.name,
    category: b.category,
    url: b.url,
    backupStream1: b.backup_stream_1,
    backupStream2: b.backup_stream_2,
    origin: b.origin,
    referer: b.referer,
    userAgent: b.user_agent,
    playerType: b.player_type,
    accessPremium: b.access_premium,
    live: b.live,
    hd: b.hd,
    active: b.active,
    showInApp: b.show_in_app,
    thumbnailUrl: b.thumbnail_url,
    createdAt,
    updatedAt,
  }
}

/** PUT: merge body into existing channel (preserve thumbnail if not sent) */
export function mergeStoredWithBody(existing, body) {
  const b = bodyToInsert(body)
  const thumb =
    body.thumbnailUrl !== undefined
      ? b.thumbnail_url
      : existing.thumbnailUrl ?? null
  const now = new Date().toISOString()
  return {
    ...existing,
    name: b.name,
    category: b.category,
    url: b.url,
    backupStream1: b.backup_stream_1,
    backupStream2: b.backup_stream_2,
    origin: b.origin,
    referer: b.referer,
    userAgent: b.user_agent,
    playerType: b.player_type,
    accessPremium: b.access_premium,
    live: b.live,
    hd: b.hd,
    active: b.active,
    showInApp: b.show_in_app,
    thumbnailUrl: thumb,
    updatedAt: now,
  }
}
