/**
 * OneSignal REST API — production broadcast only.
 * @see https://documentation.onesignal.com/reference/create-notification
 *
 * POST https://api.onesignal.com/notifications
 * Body matches dashboard “send to Subscribed Users” (User Model + push channel).
 */

const ONESIGNAL_API_URL = 'https://api.onesignal.com/notifications'
const PRODUCTION_SEGMENT = 'Subscribed Users'
const ONESIGNAL_LOG_MAX = 24_000

function getConfig() {
  const appId = String(process.env.ONESIGNAL_APP_ID ?? '').trim()
  const restKey = String(process.env.ONESIGNAL_REST_API_KEY ?? process.env.ONESIGNAL_API_KEY ?? '').trim()
  return { appId, restKey }
}

export function isOneSignalConfigured() {
  const { appId, restKey } = getConfig()
  return Boolean(appId && restKey)
}

function logOneSignalProduction(phase, payload) {
  try {
    let line = JSON.stringify({ oneSignalProduction: true, phase, ...payload })
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

/**
 * Build the exact production broadcast body (no filters, aliases, or subscription lists).
 */
export function buildProductionOneSignalBody({ appId, title, message }) {
  return {
    app_id: appId,
    included_segments: [PRODUCTION_SEGMENT],
    target_channel: 'push',
    headings: { en: String(title).trim() },
    contents: { en: String(message).trim() },
  }
}

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.message
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

  const requestPayload = buildProductionOneSignalBody({ appId, title, message })
  const requestHeaders = {
    'Content-Type': 'application/json; charset=utf-8',
    Authorization: 'Key [REDACTED]',
  }

  logOneSignalProduction('before_post', {
    source: logMeta.source ?? 'notifications.sendOneSignalNotification',
    method: 'POST',
    url: ONESIGNAL_API_URL,
    requestHeaders,
    requestPayload,
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

  logOneSignalProduction('after_post', {
    source: logMeta.source ?? 'notifications.sendOneSignalNotification',
    httpStatus: res.status,
    ok: res.ok,
    requestPayload,
    rawOneSignalResponse: raw,
  })

  if (!res.ok) {
    throw new Error(`OneSignal API error (${res.status}): ${formatOneSignalFailure(res.status, raw)}`)
  }

  const id = raw?.id != null ? String(raw.id).trim() : ''
  const hasErrors =
    (Array.isArray(raw?.errors) && raw.errors.length > 0) ||
    (raw?.errors && typeof raw.errors === 'object' && Object.keys(raw.errors).length > 0)

  if (!id || hasErrors) {
    const errMsg = formatOneSignalFailure(res.status, raw)
    throw new Error(
      errMsg || `OneSignal: no notification id (likely zero push subscribers in "${PRODUCTION_SEGMENT}")`,
    )
  }

  const recipients = Number(raw.recipients ?? raw.successful ?? 0) || 0
  return { id, recipients, raw }
}
