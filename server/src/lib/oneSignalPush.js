/**
 * OneSignal REST API — production push (no mock).
 * @see https://documentation.onesignal.com/reference/create-notification
 *
 * Uses the current Create notification URL (`https://api.onesignal.com/notifications`).
 * Legacy `https://onesignal.com/api/v1/notifications` can mis-resolve segment/filter audiences
 * for User Model apps while subscription-id sends still appear to work. Override with
 * ONESIGNAL_API_URL if needed.
 *
 * Audience (non-all): uses tag filter. Mobile app must set the same tag on devices, e.g.
 *   OneSignal.User.addTag("osmani_audience", "premium")
 * Tag key overridable via ONESIGNAL_AUDIENCE_TAG_KEY (default: osmani_audience).
 * Tag values: premium | trial | inactive (must match admin dropdown).
 * Push channel: sets `target_channel: 'push'` (same as successful admin test with aliases).
 *
 * Debug / verification (admin only, separate route): {@link sendOneSignalTestTargetedPush}
 * uses include_subscription_ids, include_aliases.onesignal_id (+ target_channel push), or
 * include_player_ids — no segments/filters. Only one targeting mode per request.
 */

const ONESIGNAL_API_DEFAULT = 'https://api.onesignal.com/notifications'

function getOneSignalApiUrl() {
  const u = String(process.env.ONESIGNAL_API_URL ?? '').trim()
  return u || ONESIGNAL_API_DEFAULT
}

/** Classify targeting from the exact object POSTed to OneSignal (after app_id merge). */
export function classifyOneSignalTargetingWire(body) {
  const b = body && typeof body === 'object' ? body : {}
  if (Array.isArray(b.include_subscription_ids) && b.include_subscription_ids.length > 0) {
    return { branch: 'include_subscription_ids', detail: `${b.include_subscription_ids.length} id(s)` }
  }
  const aliasOs = b.include_aliases?.onesignal_id
  if (Array.isArray(aliasOs) && aliasOs.length > 0) {
    return { branch: 'include_aliases.onesignal_id', detail: `${aliasOs.length} id(s)` }
  }
  if (Array.isArray(b.include_player_ids) && b.include_player_ids.length > 0) {
    return { branch: 'include_player_ids', detail: `${b.include_player_ids.length} id(s)` }
  }
  if (Array.isArray(b.included_segments) && b.included_segments.length > 0) {
    return { branch: 'included_segments', detail: b.included_segments.join(', ') }
  }
  if (Array.isArray(b.filters) && b.filters.length > 0) {
    return { branch: 'filters', detail: `${b.filters.length} rule(s)` }
  }
  return { branch: 'none', detail: '' }
}

const ONESIGNAL_LOG_MAX = 24_000

function logOneSignalDiag(phase, payload) {
  try {
    let line = JSON.stringify({ oneSignalDiag: true, phase, ...payload })
    if (line.length > ONESIGNAL_LOG_MAX) line = `${line.slice(0, ONESIGNAL_LOG_MAX)}…[truncated]`
    console.log(line)
  } catch (e) {
    console.log('[OneSignal] diag log failed:', String(e?.message || e))
  }
}

function getConfig() {
  const appId = String(process.env.ONESIGNAL_APP_ID ?? '').trim()
  const restKey = String(process.env.ONESIGNAL_REST_API_KEY ?? process.env.ONESIGNAL_API_KEY ?? '').trim()
  const audienceTagKey = String(process.env.ONESIGNAL_AUDIENCE_TAG_KEY ?? 'osmani_audience').trim() || 'osmani_audience'
  return { appId, restKey, audienceTagKey }
}

export function isOneSignalConfigured() {
  const { appId, restKey } = getConfig()
  return Boolean(appId && restKey)
}

/**
 * @param {object} body - Notification body (app_id merged from env if omitted).
 * @param {object} [meta]
 * @param {string} [meta.source] - e.g. notifications.createAdminNotification, notifications.flushDue, onesignal-test-push
 * @param {string} [meta.targetingBranchSelected] - optional: branch chosen before POST (test helper)
 * @param {object} [meta.idCounts] - optional: { subscriptions, onesignalUsers, players }
 */
async function postOneSignalCreate(body, meta = {}) {
  const { appId, restKey } = getConfig()
  if (!appId || !restKey) {
    throw new Error(
      'OneSignal is not configured. Set ONESIGNAL_APP_ID and ONESIGNAL_REST_API_KEY in the server environment.',
    )
  }
  const full = { ...body, app_id: body.app_id ?? appId }
  const wire = classifyOneSignalTargetingWire(full)
  const targetingBranchSelected =
    meta.targetingBranchSelected != null && meta.targetingBranchSelected !== ''
      ? String(meta.targetingBranchSelected)
      : null

  const apiUrl = getOneSignalApiUrl()
  // TEMP: exact wire verification (production + test). Remove after diagnosing OneSignal targeting.
  logOneSignalDiag('before_post', {
    source: meta.source || 'unknown',
    url: apiUrl,
    targetingWire: wire.branch,
    targetingWireDetail: wire.detail,
    targetingBranchSelected,
    requestPayload: full,
  })

  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Key ${restKey}`,
    },
    body: JSON.stringify(full),
  })
  const raw = await res.json().catch(() => ({}))

  logOneSignalDiag('after_post', {
    source: meta.source || 'unknown',
    url: apiUrl,
    httpStatus: res.status,
    ok: res.ok,
    targetingWire: wire.branch,
    targetingWireDetail: wire.detail,
    targetingBranchSelected,
    requestPayload: full,
    rawOneSignalResponse: raw,
  })
  if (!res.ok) {
    let errMsg = raw?.error ? String(raw.error) : ''
    if (Array.isArray(raw?.errors)) errMsg = raw.errors.map(String).join('; ')
    else if (raw?.errors && typeof raw.errors === 'object') errMsg = JSON.stringify(raw.errors)
    errMsg =
      errMsg ||
      raw?.invalid_aliases ||
      String(res.statusText || res.status)
    throw new Error(`OneSignal API error (${res.status}): ${errMsg}`)
  }
  const id = raw?.id != null ? String(raw.id) : ''
  if (!id) {
    throw new Error(`OneSignal: missing notification id in response: ${JSON.stringify(raw).slice(0, 500)}`)
  }
  const recipients = Number(raw.recipients ?? raw.successful ?? 0) || 0
  return { id, recipients, raw }
}

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.message
 * @param {string} [opts.url] - deep link e.g. osmani://home
 * @param {string} [opts.imageUrl] - HTTPS public URL for rich image (Android big_picture / iOS attachment)
 * @param {'all'|'premium'|'trial'|'inactive'} opts.audience
 * @param {object} [logMeta] - forwarded to postOneSignalCreate (source, notificationId, …)
 * @returns {Promise<{ id: string, recipients: number, raw: object }>}
 */
export async function sendOneSignalNotification(opts, logMeta = {}) {
  const { audienceTagKey } = getConfig()

  const title = String(opts.title ?? '').trim()
  const message = String(opts.message ?? '').trim()
  if (!title) throw new Error('OneSignal: title is required')
  if (!message) throw new Error('OneSignal: message is required')

  const audience = String(opts.audience ?? 'all').toLowerCase()
  const url = String(opts.url ?? '').trim() || undefined
  const imageUrl = String(opts.imageUrl ?? '').trim()

  const body = {
    headings: { en: title },
    contents: { en: message },
  }

  if (url) {
    body.url = url
    body.data = { deep_link: url }
  }

  if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
    body.big_picture = imageUrl
    body.chrome_web_image = imageUrl
    body.ios_attachments = { id1: imageUrl }
  }

  if (audience === 'all') {
    body.included_segments = ['Subscribed Users']
  } else {
    body.filters = [{ field: 'tag', key: audienceTagKey, relation: '=', value: audience }]
  }
  body.target_channel = 'push'

  const targetingBranchSelected =
    audience === 'all'
      ? 'included_segments[Subscribed Users] + target_channel:push'
      : `filters[tag:${audienceTagKey}=${audience}] + target_channel:push`

  return postOneSignalCreate(body, {
    ...logMeta,
    source: logMeta.source ?? 'notifications.sendOneSignalNotification',
    audience,
    targetingBranchSelected,
  })
}

/**
 * Admin verification only: target explicit IDs (no segments, no filters).
 * - Push **subscription** UUID → `include_subscription_ids` (per-device/channel row in dashboard).
 * - OneSignal **user** UUID (`onesignal_id`) → `include_aliases` + `target_channel: push` (User ID on profile).
 * - Legacy player id → `include_player_ids`.
 */
export async function sendOneSignalTestTargetedPush({
  subscriptionIds = [],
  oneSignalUserIds = [],
  playerIds = [],
  title = 'Osmani admin test',
  message = 'Backend OneSignal delivery test',
  url = 'osmani://home',
}) {
  const subs = (Array.isArray(subscriptionIds) ? subscriptionIds : [])
    .map((x) => String(x ?? '').trim())
    .filter(Boolean)
  const osUsers = (Array.isArray(oneSignalUserIds) ? oneSignalUserIds : [])
    .map((x) => String(x ?? '').trim())
    .filter(Boolean)
  const players = (Array.isArray(playerIds) ? playerIds : [])
    .map((x) => String(x ?? '').trim())
    .filter(Boolean)
  if (subs.length === 0 && osUsers.length === 0 && players.length === 0) {
    throw new Error(
      'OneSignal test: provide at least one push subscription id, onesignal user id, or legacy player id',
    )
  }

  const body = {
    headings: { en: String(title).trim() || 'Osmani admin test' },
    contents: { en: String(message).trim() || 'Backend OneSignal delivery test' },
  }
  const u = String(url ?? '').trim()
  if (u) {
    body.url = u
    body.data = { deep_link: u }
  }

  const targetingBranchSelected =
    subs.length > 0 ? 'include_subscription_ids' : osUsers.length > 0 ? 'include_aliases.onesignal_id' : 'include_player_ids'

  if (subs.length > 0) {
    body.include_subscription_ids = subs.slice(0, 2000)
  } else if (osUsers.length > 0) {
    body.include_aliases = { onesignal_id: osUsers.slice(0, 20000) }
    body.target_channel = 'push'
  } else {
    body.include_player_ids = players.slice(0, 2000)
  }

  return postOneSignalCreate(body, {
    source: 'onesignal-test-push',
    targetingBranchSelected,
    idCounts: { subscriptions: subs.length, onesignalUsers: osUsers.length, players: players.length },
  })
}
