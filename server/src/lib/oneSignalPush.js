/**
 * OneSignal REST API — production broadcast only.
 * @see https://documentation.onesignal.com/reference/create-notification
 *
 * POST https://api.onesignal.com/notifications
 * Body: target_channel push + included_segments ["Total Subscriptions"].
 */

import { isRenderRuntime } from './startupReadiness.js'

const ONESIGNAL_API_URL = 'https://api.onesignal.com/notifications'
const PRODUCTION_SEGMENT = 'Total Subscriptions'
const ONESIGNAL_LOG_MAX = 24_000
const IMAGE_HEAD_TIMEOUT_MS = Math.max(2000, Number(process.env.ONESIGNAL_IMAGE_HEAD_TIMEOUT_MS) || 8000)

export function getOneSignalConfig() {
  const appId = String(process.env.ONESIGNAL_APP_ID ?? '').trim()
  const restKey = String(process.env.ONESIGNAL_REST_API_KEY ?? process.env.ONESIGNAL_API_KEY ?? '').trim()
  return { appId, restKey }
}

function getConfig() {
  return getOneSignalConfig()
}

export function isOneSignalConfigured() {
  const { appId, restKey } = getConfig()
  return Boolean(appId && restKey)
}

export function getOneSignalApiHostLabel() {
  if (isRenderRuntime()) return 'render'
  const base = String(process.env.BASE_URL || process.env.NOTIFICATION_IMAGE_PUBLIC_ORIGIN || '').toLowerCase()
  if (base.includes('osmanitv.com') || base.includes('144.91.117.90')) return 'vps'
  return 'unknown'
}

function logOneSignalProduction(phase, payload) {
  try {
    let line = JSON.stringify({ oneSignalProduction: true, phase, api_host: getOneSignalApiHostLabel(), ...payload })
    if (line.length > ONESIGNAL_LOG_MAX) line = `${line.slice(0, ONESIGNAL_LOG_MAX)}…[truncated]`
    console.log(line)
  } catch (e) {
    console.log('[OneSignal] log failed:', String(e?.message || e))
  }
}

function formatOneSignalFailure(httpStatus, raw) {
  let errMsg = raw?.error ? String(raw.error) : ''
  if (Array.isArray(raw?.errors)) errMsg = raw.errors.map(String).join('; ')
  else if (raw?.errors && typeof raw.errors === 'object') errMsg = JSON.stringify(raw.errors)
  errMsg = errMsg || String(httpStatus)
  return errMsg
}

function isImageRelatedError(msg) {
  const m = String(msg || '').toLowerCase()
  return (
    m.includes('big_picture') ||
    m.includes('attachment') ||
    m.includes('image') ||
    m.includes('picture') ||
    m.includes('invalid url')
  )
}

/** HEAD-check that the push image URL OneSignal will fetch is reachable. */
export async function validatePushImageUrl(imageUrl) {
  const url = String(imageUrl ?? '').trim()
  if (!url.startsWith('https://')) return { ok: false, reason: 'not_https' }

  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(IMAGE_HEAD_TIMEOUT_MS),
    })
    if (!res.ok) return { ok: false, reason: `http_${res.status}` }
    const ct = String(res.headers.get('content-type') || '').toLowerCase()
    if (ct && !ct.includes('image') && !ct.includes('octet-stream')) {
      return { ok: false, reason: `content_type_${ct}` }
    }
    return { ok: true, validatedUrl: url }
  } catch (e) {
    return { ok: false, reason: String(e?.message || e).slice(0, 120) }
  }
}

/**
 * Build the production broadcast body (no filters, aliases, or subscription lists).
 * @param {string} [imageUrl] - public HTTPS URL for rich push (Android big_picture, etc.)
 */
export function buildProductionOneSignalBody({ appId, title, message, imageUrl, data }) {
  const body = {
    app_id: appId,
    target_channel: 'push',
    included_segments: [PRODUCTION_SEGMENT],
    headings: { en: String(title).trim() },
    contents: { en: String(message).trim() },
  }
  const img = String(imageUrl ?? '').trim()
  if (img.startsWith('https://')) {
    body.big_picture = img
    body.chrome_web_image = img
    body.ios_attachments = { id1: img }
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const flat = {}
    for (const [key, val] of Object.entries(data)) {
      if (val == null) continue
      flat[String(key).slice(0, 64)] = String(val).slice(0, 2048)
    }
    if (Object.keys(flat).length > 0) body.data = flat
  }
  return body
}

async function postOneSignalNotification(requestPayload, restKey, logMeta = {}) {
  logOneSignalProduction('before_post', {
    source: logMeta.source ?? 'notifications.sendOneSignalNotification',
    method: 'POST',
    url: ONESIGNAL_API_URL,
    requestHeaders: { 'Content-Type': 'application/json; charset=utf-8', Authorization: 'Key [REDACTED]' },
    requestPayload,
    push_image_included: Boolean(requestPayload.big_picture),
  })

  const res = await fetch(ONESIGNAL_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Key ${restKey}`,
    },
    body: JSON.stringify(requestPayload),
  })

  const raw = await res.json().catch(() => ({}))
  const recipients = Number(raw?.recipients ?? raw.successful ?? 0) || 0
  const failed = Number(raw?.failed ?? 0) || 0
  const errored = Number(raw?.errored ?? 0) || 0

  logOneSignalProduction('after_post', {
    source: logMeta.source ?? 'notifications.sendOneSignalNotification',
    httpStatus: res.status,
    ok: res.ok,
    requestPayload,
    recipients,
    failed,
    errored,
    rejected_player_ids: Array.isArray(raw?.errors) ? raw.errors.slice(0, 20) : raw?.errors ?? null,
    rawOneSignalResponse: raw,
  })

  return { res, raw, recipients, failed, errored }
}

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.message
 * @param {string} [opts.imageUrl] - public HTTPS image URL for rich push
 * @param {object} [logMeta] - e.g. { source: 'notifications.createAdminNotification' }
 */
export async function sendOneSignalNotification(opts, logMeta = {}) {
  const { appId, restKey } = getConfig()
  if (!appId || !restKey) {
    throw new Error(
      'OneSignal is not configured. Set ONESIGNAL_APP_ID and ONESIGNAL_REST_API_KEY in the server environment.',
    )
  }

  const title = String(opts.title ?? '').trim()
  const message = String(opts.message ?? '').trim()
  if (!title) throw new Error('OneSignal: title is required')
  if (!message) throw new Error('OneSignal: message is required')

  let imageUrl = String(opts.imageUrl ?? '').trim()
  let imageSkipped = false
  let imageSkipReason = null

  if (imageUrl) {
    const check = await validatePushImageUrl(imageUrl)
    if (!check.ok) {
      imageSkipped = true
      imageSkipReason = check.reason
      imageUrl = ''
      logOneSignalProduction('image_skipped', {
        source: logMeta.source,
        reason: check.reason,
        attempted_url: String(opts.imageUrl).slice(0, 240),
      })
    }
  }

  const requestPayload = buildProductionOneSignalBody({
    appId,
    title,
    message,
    imageUrl: imageUrl || undefined,
    data: opts.data,
  })

  let { res, raw, recipients } = await postOneSignalNotification(requestPayload, restKey, logMeta)

  if (!res.ok && imageUrl && isImageRelatedError(formatOneSignalFailure(res.status, raw))) {
    logOneSignalProduction('image_fallback_retry', {
      source: logMeta.source,
      reason: formatOneSignalFailure(res.status, raw),
    })
    const textOnlyPayload = buildProductionOneSignalBody({ appId, title, message, data: opts.data })
    ;({ res, raw, recipients } = await postOneSignalNotification(textOnlyPayload, restKey, {
      ...logMeta,
      source: `${logMeta.source || 'send'}:text_fallback`,
    }))
    imageSkipped = true
    imageSkipReason = imageSkipReason || 'api_image_rejected'
  }

  if (!res.ok) {
    throw new Error(`OneSignal API error (${res.status}): ${formatOneSignalFailure(res.status, raw)}`)
  }

  const id = raw?.id != null ? String(raw.id).trim() : ''
  const hasErrors =
    (Array.isArray(raw?.errors) && raw.errors.length > 0) ||
    (raw?.errors && typeof raw.errors === 'object' && Object.keys(raw.errors).length > 0)

  if (!id || hasErrors) {
    const errMsg = formatOneSignalFailure(res.status, raw)
    let hint = ''
    try {
      const appRes = await fetch(`https://api.onesignal.com/apps/${encodeURIComponent(appId)}`, {
        headers: { Authorization: `Key ${restKey}` },
      })
      const appRaw = await appRes.json().catch(() => ({}))
      if (appRes.ok) {
        hint = ` App stats: players=${appRaw?.players ?? '?'}, messageable_players=${appRaw?.messageable_players ?? '?'}.`
      }
    } catch {
      /* ignore */
    }
    throw new Error(
      (errMsg || `OneSignal: no notification id (likely zero push subscribers in "${PRODUCTION_SEGMENT}")`) + hint,
    )
  }

  return {
    id,
    recipients,
    raw,
    imageSkipped,
    imageSkipReason,
    pushImageUrl: imageUrl || null,
    apiHost: getOneSignalApiHostLabel(),
  }
}
