import { getAdminDeviceFingerprintRaw } from './adminDeviceFingerprint'
import { getAdminSessionToken } from './adminSessionStorage'
import { bannerSaveBody } from './bannerSaveBody.js'

const API_BASE_ENV = String(
  import.meta.env.VITE_API_URL || import.meta.env.VITE_API_BASE_URL || '',
).trim()

/** Render static admin must call the VPS API (shared PostgreSQL; uploads live on VPS disk). */
const VPS_PRODUCTION_API = 'https://api.osmanitv.com/api'

function resolveBrowserApiBase(origin) {
  const host = String(origin || '')
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    .toLowerCase()
  if (host === 'osmani-admin-mpya.onrender.com') {
    return VPS_PRODUCTION_API
  }
  return `${String(origin).replace(/\/$/, '')}/api`
}

function normalizeApiBase(raw) {
  const s = String(raw || '').trim()
  if (s) {
    const clean = s.replace(/\/$/, '')
    if (/\/api$/i.test(clean)) return clean
    return `${clean}/api`
  }
  if (typeof window !== 'undefined' && window.location?.origin) {
    return resolveBrowserApiBase(window.location.origin)
  }
  // Build-time / SSR: same-origin relative path (Contabo nginx proxies /api → Node).
  return '/api'
}

export const API_BASE = normalizeApiBase(API_BASE_ENV)
export const API_ORIGIN = API_BASE.replace(/\/api$/i, '')

/** Admin UI fetches: bypass HTTP disk/memory cache so reads after writes match PostgreSQL. */
const ADMIN_FETCH_DEFAULTS = { cache: 'no-store' }

async function parseJsonSafe(res) {
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function msgFromBody(body, status) {
  if (body && typeof body === 'object' && body.providerMessage) return String(body.providerMessage)
  if (body && typeof body === 'object' && body.error) return String(body.error)
  if (body && typeof body === 'object' && body.message) return String(body.message)
  if (typeof body === 'string' && body.length < 200) return body
  return `Request failed (${status})`
}

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

function joinPath(path) {
  const p = path.startsWith('/') ? path : `/${path}`
  return `${API_BASE}${p}`
}

export async function apiGet(path) {
  const res = await fetch(joinPath(path), { cache: 'no-store' })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function apiPost(path, data) {
  const res = await fetch(joinPath(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: data === undefined ? '{}' : JSON.stringify(data),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function apiPut(path, data) {
  const res = await fetch(joinPath(path), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: data === undefined ? '{}' : JSON.stringify(data),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function apiDelete(path) {
  const res = await fetch(joinPath(path), { method: 'DELETE' })
  const body = res.status === 204 ? null : await parseJsonSafe(res)
  if (!res.ok && res.status !== 204) {
    throw new ApiError(msgFromBody(body, res.status), res.status, body)
  }
  return body
}

async function parseJsonSafeResponse(res) {
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

/** --- Channels --- */
export async function getChannels() {
  const data = await apiGet('/channels')
  return Array.isArray(data) ? data : []
}

export function addChannel(data) {
  return adminApiPost('/channels', data)
}

export function updateChannel(id, data) {
  return adminApiPut(`/channels/${encodeURIComponent(id)}`, data)
}

export function addChannelFormData(formData) {
  return fetch(joinPath('/channels'), {
    ...ADMIN_FETCH_DEFAULTS,
    method: 'POST',
    headers: adminPanelFormDataHeaders(),
    body: formData,
  }).then(parseJsonSafeResponse)
}

export function updateChannelFormData(id, formData) {
  return fetch(joinPath(`/channels/${encodeURIComponent(id)}`), {
    ...ADMIN_FETCH_DEFAULTS,
    method: 'PUT',
    headers: adminPanelFormDataHeaders(),
    body: formData,
  }).then(parseJsonSafeResponse)
}

export function postChannelsReorder(orders) {
  return adminApiPost('/channels/reorder', { orders })
}

export function deleteChannel(id) {
  return adminApiDelete(`/channels/${encodeURIComponent(id)}`)
}

/** Clone channel fields to a new row (new id, fresh timestamps, name suffixed with " (Copy)"). */
export function duplicateChannel(id) {
  return adminApiPost(`/channels/${encodeURIComponent(id)}/duplicate`, {})
}

export function uploadInstructionVideo(channelId, videoFile) {
  return uploadInstructionVideoWithProgress(channelId, videoFile)
}

let instructionVideoUploadInFlight = null

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Upload instruction video with real XHR progress, speed/ETA, duplicate guard, and retries.
 * @param {number|string} channelId
 * @param {Blob|File} videoFile
 * @param {{ onProgress?: (p: { percent: number, loaded: number, total: number, speedBps: number, etaSec: number|null }) => void, signal?: AbortSignal, maxRetries?: number }} [opts]
 */
export function uploadInstructionVideoWithProgress(channelId, videoFile, opts = {}) {
  const { onProgress, signal, maxRetries = 3 } = opts
  const id = String(channelId)
  if (instructionVideoUploadInFlight?.channelId === id) {
    return Promise.reject(
      new ApiError('An upload is already in progress for this channel', 409, { error: 'duplicate_upload' }),
    )
  }

  const controller = new AbortController()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  instructionVideoUploadInFlight = { channelId: id, abort: () => controller.abort() }

  const runAttempt = () =>
    new Promise((resolve, reject) => {
      if (controller.signal.aborted) {
        reject(new ApiError('Upload cancelled', 0))
        return
      }
      const fd = new FormData()
      fd.append('video', videoFile, videoFile.name || 'instruction.mp4')
      const xhr = new XMLHttpRequest()
      xhr.open('POST', joinPath(`/channels/${encodeURIComponent(id)}/instruction-video`))
      const headers = adminPanelFormDataHeaders()
      for (const [key, value] of Object.entries(headers)) {
        if (value != null) xhr.setRequestHeader(key, String(value))
      }
      let lastLoaded = 0
      let lastTime = Date.now()
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return
        const now = Date.now()
        const dt = Math.max(0.001, (now - lastTime) / 1000)
        const delta = e.loaded - lastLoaded
        const speedBps = delta / dt
        lastLoaded = e.loaded
        lastTime = now
        const etaSec = speedBps > 0 ? (e.total - e.loaded) / speedBps : null
        onProgress?.({
          percent: Math.min(100, Math.round((e.loaded / e.total) * 100)),
          loaded: e.loaded,
          total: e.total,
          speedBps,
          etaSec,
        })
      }
      xhr.onload = () => {
        let body = null
        try {
          body = xhr.responseText ? JSON.parse(xhr.responseText) : null
        } catch {
          body = xhr.responseText
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          onProgress?.({
            percent: 100,
            loaded: videoFile.size ?? 0,
            total: videoFile.size ?? 0,
            speedBps: 0,
            etaSec: 0,
          })
          resolve(body)
          return
        }
        const retryable = xhr.status === 0 || xhr.status >= 500 || xhr.status === 408 || xhr.status === 429
        const err = new ApiError(msgFromBody(body, xhr.status), xhr.status, body)
        err.retryable = retryable
        reject(err)
      }
      xhr.onerror = () => {
        const err = new ApiError('Network error during upload', 0)
        err.retryable = true
        reject(err)
      }
      xhr.onabort = () => reject(new ApiError('Upload cancelled', 0))
      controller.signal.addEventListener('abort', () => xhr.abort(), { once: true })
      xhr.send(fd)
    })

  return (async () => {
    try {
      let lastErr
      for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
        try {
          return await runAttempt()
        } catch (e) {
          lastErr = e
          if (e?.retryable && attempt < maxRetries) {
            await sleep(1000 * attempt)
            continue
          }
          throw e
        }
      }
      throw lastErr
    } finally {
      instructionVideoUploadInFlight = null
    }
  })()
}

/** Global app modes (Free / Emergency / Maintenance) — GET/PUT /api/settings */
export const getAppGlobalSettings = () => adminApiGet('/settings')
export const putAppGlobalSettings = (body) => adminApiPut('/settings', body)

export const getTrialWatchSettings = () => adminApiGet('/settings/trial-watch')
export const putTrialWatchSettings = (body) => adminApiPut('/settings/trial-watch', body)
export const getRuntimeTrialWatchSettings = () => apiGet('/runtime/trial-watch')

/** Public OTA app-update flags (installer soft/force/auto-download, APK URL/hash). */
export const getRuntimeAppUpdateSettings = () => apiGet('/runtime/app-update')

/** Shared DB-backed modes (no auth). Keeps admin UI + runtimes aligned across multi-instance hosts. */
export const getPublicRuntimeAppModes = () => apiGet('/runtime/app-modes')

/** --- Banners --- */
/** Public list (active + enabled + schedule). */
export const getBanners = () => apiGet('/banners')
/** Full list for admin CMS. */
export const getBannersManage = () => adminApiGet('/banners/manage')

export function postBanner(body) {
  const payload = bannerSaveBody(body)
  if (import.meta.env?.DEV) {
    console.info('[banner-save] POST /banners payload', {
      runtime_position: payload.runtime_position,
      runtimePosition: payload.runtimePosition,
    })
  }
  return adminApiPost('/banners', payload)
}

export function putBanner(id, body) {
  const payload = bannerSaveBody(body)
  if (import.meta.env?.DEV) {
    console.info('[banner-save] PUT /banners/' + id, {
      runtime_position: payload.runtime_position,
      runtimePosition: payload.runtimePosition,
    })
  }
  return adminApiPut(`/banners/${encodeURIComponent(id)}`, payload)
}

/** Drag-reorder: updates sort_order only (does not touch runtime_position). */
export function postBannersReorder(orders) {
  return adminApiPost('/banners/reorder', { orders })
}

export const deleteBanner = (id) => adminApiDelete(`/banners/${encodeURIComponent(id)}`)

/** --- Plans --- (GET public for Android checkout; mutations require admin session/token) */
export const getPlans = () => apiGet('/plans')
export const postPlan = (body) => adminApiPost('/plans', body)
export const putPlan = (id, body) => adminApiPut(`/plans/${encodeURIComponent(id)}`, body)
export const deletePlan = (id) => adminApiDelete(`/plans/${encodeURIComponent(id)}`)

/** --- Users --- (admin-only; drives subscription rows — Android notified via SSE + subscription-stream) */
function usersListQuery(params = {}) {
  const q = new URLSearchParams()
  if (params.page != null) q.set('page', String(params.page))
  if (params.limit != null) q.set('limit', String(params.limit))
  if (params.search) q.set('search', String(params.search))
  if (params.sort) q.set('sort', String(params.sort))
  if (params.plan_id != null && params.plan_id !== 'all') q.set('plan_id', String(params.plan_id))
  if (params.provider && params.provider !== 'all') q.set('provider', String(params.provider))
  if (params.status && params.status !== 'all') q.set('status', String(params.status))
  if (params.within) q.set('within', String(params.within))
  return q.toString()
}

export const getUsersSummary = (opts = {}) => adminApiGet('/users/summary', opts)
export const getUsersActive = (params = {}, opts = {}) => {
  const qs = usersListQuery(params)
  return adminApiGet(qs ? `/users/active?${qs}` : '/users/active', opts)
}
export const getUsersExpiring = (params = {}, opts = {}) => {
  const qs = usersListQuery(params)
  return adminApiGet(qs ? `/users/expiring?${qs}` : '/users/expiring', opts)
}
export const getUsersFailedPayments = (params = {}, opts = {}) => {
  const qs = usersListQuery(params)
  return adminApiGet(qs ? `/users/failed-payments?${qs}` : '/users/failed-payments', opts)
}
export const getUsers = (params = {}, opts = {}) => {
  const qs = usersListQuery(params)
  return adminApiGet(qs ? `/users?${qs}` : '/users', opts)
}
export const getUsersLookup = (q, opts = {}) => {
  const qs = new URLSearchParams({ q: String(q ?? '').trim() })
  return adminApiGet(`/users/lookup?${qs}`, opts)
}
/** Full list for legacy admin screens (e.g. Plans subscriber counts). Prefer paginated getUsers. */
export const getUsersLegacy = () => adminApiGet('/users?legacy=1')

function customerInvestigationQuery(params = {}) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    const s = String(v ?? '').trim()
    if (s) q.set(k, s)
  }
  return q.toString()
}

export const investigateCustomer = (params = {}) => {
  const qs = customerInvestigationQuery(params)
  return adminApiGet(qs ? `/admin/customer-investigation/investigate?${qs}` : '/admin/customer-investigation/investigate')
}
export const customerInvestigationReconcile = (body) =>
  adminApiPost('/admin/customer-investigation/actions/reconcile', body)
export const customerInvestigationRefreshSubscription = (body) =>
  adminApiPost('/admin/customer-investigation/actions/refresh-subscription', body)
export const customerInvestigationForceActivate = (body) =>
  adminApiPost('/admin/customer-investigation/actions/force-activate', body)
export const customerInvestigationForceTransfer = (body) =>
  adminApiPost('/admin/customer-investigation/actions/force-transfer', body)

export const postUserRevoke = (deviceId, body = {}) =>
  adminApiPost(`/users/${encodeURIComponent(deviceId)}/revoke`, body)

export const postUsersBulkRevoke = (body) => adminApiPost('/users/bulk-revoke', body)

export const postUser = (body) => adminApiPost('/users', body)
export const putUser = (id, body) => adminApiPut(`/users/${encodeURIComponent(id)}`, body)
export const deleteUser = (id, { force = false } = {}) => {
  const path = force
    ? `/users/${encodeURIComponent(id)}?force=true`
    : `/users/${encodeURIComponent(id)}`
  return adminApiDelete(path)
}

/** Bulk delete device subscriptions (admin). Body: { device_ids: string[], force?: boolean } */
export const deleteUsersBulk = (body) =>
  adminApiRequest('/users/bulk', { method: 'DELETE', body })

/** --- Transactions --- (optional server-side filters) */
export function getTransactions(params = {}) {
  const q = new URLSearchParams()
  if (params.status && params.status !== 'all') q.set('status', params.status)
  if (params.from) q.set('from', params.from)
  if (params.to) q.set('to', params.to)
  const s = q.toString()
  return adminApiGet(s ? `/transactions?${s}` : '/transactions')
}
export async function deleteTransactionsBulk(ids) {
  return adminApiRequest('/transactions/bulk', {
    method: 'DELETE',
    body: { ids: Array.isArray(ids) ? ids : [] },
  })
}

/** Initiate ZenoPay collection (uses server-stored credentials + env overrides). */
export const postCreatePayment = (body) => apiPost('/payments/create-payment', body)

/** Public: checkout providers (auraxpay_test = configured for admin test; auraxpay = production enabled). */
export const getCheckoutPaymentProviders = () => apiGet('/payments/checkout-providers')

/** Initiate SonicPesa payment (separate from ZenoPay; tags transaction as sonicpesa). */
export const postSonicpesaCreateOrder = (body) => apiPost('/payments/sonicpesa/create-order', body)

/** Initiate Aurax Pay payment (mobile/production — requires gateway enabled in admin). */
export const postAuraxpayCreateOrder = (body) => apiPost('/payments/auraxpay/create-order', body)

/** Admin test checkout on ZenoPay page — uses Aurax settings even when production Enable is off. */
export const postAdminAuraxpayTestCreateOrder = (body) =>
  adminApiPost('/admin/payments/auraxpay/create-order', body)

/** Poll payment status: { order_id, status } where status is SUCCESS | PENDING | FAILED */
export const getPaymentStatus = (orderId) =>
  apiGet(`/payment-status/${encodeURIComponent(String(orderId ?? ''))}`)

/** Device subscription unlock (polling fallback). Prefer SSE `subscription-stream` for realtime. */
export function getSubscriptionStatus(input) {
  const opts =
    input && typeof input === 'object' ? input : { deviceId: input }
  const q = new URLSearchParams()
  q.set('device_id', String(opts.deviceId ?? '').trim())
  if (opts.orderId != null && String(opts.orderId).trim()) {
    q.set('order_id', String(opts.orderId).trim())
  }
  if (opts.fingerprint != null && String(opts.fingerprint).trim()) {
    q.set('fingerprint', String(opts.fingerprint).trim())
  }
  return apiGet(`/subscription-status?${q.toString()}`)
}

export const postSubscriptionVerify = (body) => apiPost('/subscription/verify', body)
export const postSubscriptionRecover = (body) => apiPost('/subscription/recover', body)
export const postSubscriptionRevoke = (body) => apiPost('/subscription/revoke', body)
export const postTransferRequest = (body) => apiPost('/transfer/request', body)
export const postTransferConfirm = (body) => apiPost('/transfer/confirm', body)
export const postAdminForceTransfer = (body) => adminApiPost('/transfer/admin-force', body)

export function subscriptionStreamUrl(deviceId, opts = {}) {
  const q = new URLSearchParams()
  q.set('device_id', String(deviceId ?? '').trim())
  if (opts.fingerprint != null && String(opts.fingerprint).trim()) {
    q.set('fingerprint', String(opts.fingerprint).trim())
  }
  return `${API_BASE}/subscription-stream?${q.toString()}`
}

/** Mobile: dismiss one-time manual gift popup after user taps ASANTE */
export const postAcknowledgeManualGift = (body) =>
  apiPost('/subscription/acknowledge-manual-gift', body)

const ADMIN_SECURITY_GATE_KEY = 'osmani_admin_security_gate'

export function getAdminSecurityGateToken() {
  if (typeof sessionStorage === 'undefined') return ''
  return sessionStorage.getItem(ADMIN_SECURITY_GATE_KEY) || ''
}

export function setAdminSecurityGateToken(token) {
  if (typeof sessionStorage === 'undefined') return
  const t = String(token ?? '').trim()
  if (t) sessionStorage.setItem(ADMIN_SECURITY_GATE_KEY, t)
  else sessionStorage.removeItem(ADMIN_SECURITY_GATE_KEY)
}

export function clearAdminSecurityGateToken() {
  if (typeof sessionStorage === 'undefined') return
  sessionStorage.removeItem(ADMIN_SECURITY_GATE_KEY)
}

/** Matches server ADMIN_API_TOKEN + optional Bearer session when ADMIN_PANEL_AUTH_REQUIRED=true. */
export function adminPanelApiHeaders() {
  const legacyToken = String(import.meta.env.VITE_ADMIN_API_TOKEN ?? '').trim() || '3030'
  const h = {
    'Content-Type': 'application/json',
    'X-Admin-Token': legacyToken,
    'X-Admin-Device-Fingerprint': getAdminDeviceFingerprintRaw(),
  }
  if (typeof localStorage !== 'undefined') {
    const jwt = getAdminSessionToken()
    if (jwt) h.Authorization = `Bearer ${jwt}`
  }
  return h
}

/** Admin Security trusted-devices page: session JWT + email OTP gate token. */
export function adminSecurityApiHeaders() {
  const h = adminPanelApiHeaders()
  const gate = getAdminSecurityGateToken()
  if (gate) h['X-Admin-Security-Gate'] = gate
  return h
}

export async function adminApiRequest(path, { method = 'GET', body, allowNoContent = false, signal } = {}) {
  const res = await fetch(joinPath(path), {
    ...ADMIN_FETCH_DEFAULTS,
    method,
    headers: adminPanelApiHeaders(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  })
  const parsed = res.status === 204 && allowNoContent ? null : await parseJsonSafe(res)
  if (!res.ok && !(allowNoContent && res.status === 204)) {
    throw new ApiError(msgFromBody(parsed, res.status), res.status, parsed)
  }
  return parsed
}

export function adminApiGet(path, opts = {}) {
  return adminApiRequest(path, opts)
}

function adminApiPost(path, body = {}) {
  return adminApiRequest(path, { method: 'POST', body })
}

function adminApiPut(path, body = {}) {
  return adminApiRequest(path, { method: 'PUT', body })
}

function adminApiDelete(path) {
  return adminApiRequest(path, { method: 'DELETE', allowNoContent: true })
}

function adminPanelFormDataHeaders() {
  const headers = { ...adminPanelApiHeaders() }
  delete headers['Content-Type']
  return headers
}

/**
 * Probe panel auth gate. Never throws: use when bootstrapping the SPA so a missing
 * `/admin/auth/status` (404) or network error cannot blank the shell.
 */
export async function getAdminAuthStatus() {
  try {
    const res = await fetch(joinPath('/admin/auth/status'), { ...ADMIN_FETCH_DEFAULTS })
    const body = await parseJsonSafe(res)
    if (!res.ok) {
      return { panelAuthRequired: false }
    }
    if (body && typeof body === 'object') {
      return body
    }
    return { panelAuthRequired: false }
  } catch {
    return { panelAuthRequired: false }
  }
}

export function postAdminLogin(body) {
  return apiPost('/admin/auth/login', body)
}

export function postAdminVerifyOtp(body) {
  return apiPost('/admin/auth/verify-otp', body)
}

export function postAdminResendOtp(body) {
  return apiPost('/admin/auth/resend-otp', body)
}

export function postAdminEmergencyPin(body) {
  return apiPost('/admin/auth/emergency-pin', body)
}

export function getAdminAuthMe() {
  return adminApiGet('/admin/auth/me')
}

export function postAdminRefreshSession() {
  return adminApiPost('/admin/auth/refresh', {})
}

export function postAdminLogout() {
  return adminApiPost('/admin/auth/logout', {})
}

export async function getAdminAuthDevices() {
  const res = await fetch(joinPath('/admin/auth/devices'), {
    ...ADMIN_FETCH_DEFAULTS,
    headers: adminSecurityApiHeaders(),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

/** Security Dashboard PIN gate only — does not send email OTP. */
export async function postVerifyAdminSecurityPin(securityPin) {
  const res = await fetch(joinPath('/admin/auth/verify-security-pin'), {
    ...ADMIN_FETCH_DEFAULTS,
    method: 'POST',
    headers: adminPanelApiHeaders(),
    body: JSON.stringify({ security_pin: String(securityPin ?? '').trim() }),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

/** Admin Security page: PIN ok → OTP challenge created and emailed. */
export async function postAdminSecurityVerifyPin(securityPin) {
  const res = await fetch(joinPath('/admin/auth/admin-security/verify-pin'), {
    ...ADMIN_FETCH_DEFAULTS,
    method: 'POST',
    headers: adminPanelApiHeaders(),
    body: JSON.stringify({ security_pin: String(securityPin ?? '').trim() }),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function postAdminSecurityResendOtp({ challengeToken }) {
  const res = await fetch(joinPath('/admin/auth/admin-security/resend-otp'), {
    ...ADMIN_FETCH_DEFAULTS,
    method: 'POST',
    headers: adminPanelApiHeaders(),
    body: JSON.stringify({ challengeToken: String(challengeToken ?? '').trim() }),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function postAdminSecurityVerifyOtp({ challengeToken, otp }) {
  const res = await fetch(joinPath('/admin/auth/admin-security/verify-otp'), {
    ...ADMIN_FETCH_DEFAULTS,
    method: 'POST',
    headers: adminPanelApiHeaders(),
    body: JSON.stringify({
      challengeToken: String(challengeToken ?? '').trim(),
      otp: String(otp ?? '').trim(),
    }),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function postAdminSecurityDestructiveStart({ securityPin, action, deviceIds }) {
  const res = await fetch(joinPath('/admin/auth/admin-security/destructive/start'), {
    ...ADMIN_FETCH_DEFAULTS,
    method: 'POST',
    headers: adminSecurityApiHeaders(),
    body: JSON.stringify({
      security_pin: String(securityPin ?? '').trim(),
      action: String(action ?? '').trim(),
      deviceIds: Array.isArray(deviceIds) ? deviceIds : undefined,
    }),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function postAdminSecurityDestructiveResendOtp({ challengeToken }) {
  const res = await fetch(joinPath('/admin/auth/admin-security/destructive/resend-otp'), {
    ...ADMIN_FETCH_DEFAULTS,
    method: 'POST',
    headers: adminSecurityApiHeaders(),
    body: JSON.stringify({ challengeToken: String(challengeToken ?? '').trim() }),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function postAdminSecurityDestructiveExecute({ challengeToken, otp, confirmCurrentDevice }) {
  const res = await fetch(joinPath('/admin/auth/admin-security/destructive/execute'), {
    ...ADMIN_FETCH_DEFAULTS,
    method: 'POST',
    headers: adminSecurityApiHeaders(),
    body: JSON.stringify({
      challengeToken: String(challengeToken ?? '').trim(),
      otp: String(otp ?? '').trim(),
      confirm_current_device: confirmCurrentDevice === true,
    }),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

function adminTrustedDeviceMutationBody(opts = {}) {
  return JSON.stringify({
    security_pin: String(opts.securityPin ?? opts.security_pin ?? '').trim(),
    confirm_current_device: opts.confirmCurrentDevice === true || opts.confirm_current_device === true,
  })
}

export async function postAdminDeviceBlock(id, opts = {}) {
  const res = await fetch(joinPath(`/admin/auth/devices/${encodeURIComponent(id)}/block`), {
    ...ADMIN_FETCH_DEFAULTS,
    method: 'POST',
    headers: adminSecurityApiHeaders(),
    body: adminTrustedDeviceMutationBody(opts),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function postAdminDeviceUnblock(id, opts = {}) {
  const res = await fetch(joinPath(`/admin/auth/devices/${encodeURIComponent(id)}/unblock`), {
    ...ADMIN_FETCH_DEFAULTS,
    method: 'POST',
    headers: adminSecurityApiHeaders(),
    body: adminTrustedDeviceMutationBody(opts),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function deleteAdminTrustedDevice(id, opts = {}) {
  const res = await fetch(joinPath(`/admin/auth/devices/${encodeURIComponent(id)}`), {
    ...ADMIN_FETCH_DEFAULTS,
    method: 'DELETE',
    headers: adminSecurityApiHeaders(),
    body: adminTrustedDeviceMutationBody(opts),
  })
  const body = res.status === 204 ? null : await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function postAdminDeviceForceOtp(id, opts = {}) {
  const res = await fetch(joinPath(`/admin/auth/devices/${encodeURIComponent(id)}/force-otp`), {
    ...ADMIN_FETCH_DEFAULTS,
    method: 'POST',
    headers: adminSecurityApiHeaders(),
    body: adminTrustedDeviceMutationBody(opts),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

/** Admin: grant stacked subscription days (PIN + phone validated on server). */
export async function getManualSubscriptionPinStatus() {
  const res = await fetch(joinPath('/admin/manual-subscription/pin-status'), {
    ...ADMIN_FETCH_DEFAULTS,
    headers: adminPanelApiHeaders(),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function postManualSubscriptionSetupPin({ pin, confirmPin }) {
  const res = await fetch(joinPath('/admin/manual-subscription/setup-pin'), {
    ...ADMIN_FETCH_DEFAULTS,
    method: 'POST',
    headers: adminPanelApiHeaders(),
    body: JSON.stringify({
      pin: String(pin ?? ''),
      confirm_pin: String(confirmPin ?? pin ?? ''),
    }),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function postManualSubscriptionGrant({ deviceId, durationDays, phone, pin }) {
  const res = await fetch(joinPath('/admin/manual-subscription/grant'), {
    ...ADMIN_FETCH_DEFAULTS,
    method: 'POST',
    headers: adminPanelApiHeaders(),
    body: JSON.stringify({
      device_id: String(deviceId ?? '').trim(),
      duration_days: Number(durationDays),
      phone: String(phone ?? '').trim(),
      pin: String(pin ?? ''),
    }),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

/** Admin: custom manual grant with explicit start/expiry (admin session auth). */
export async function postManualSubscriptionGrantCustom({
  deviceId,
  planId,
  startedAt,
  expiresAt,
  phone,
  pin,
}) {
  const res = await fetch(joinPath('/admin/manual-subscription/grant-custom'), {
    ...ADMIN_FETCH_DEFAULTS,
    method: 'POST',
    headers: adminPanelApiHeaders(),
    body: JSON.stringify({
      device_id: String(deviceId ?? '').trim(),
      plan_id: Number(planId),
      started_at: startedAt,
      expires_at: expiresAt,
      phone: String(phone ?? '').trim(),
      pin: String(pin ?? ''),
    }),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function getManualSubscriptionHistory() {
  const bust = `_cb=${Date.now()}`
  const res = await fetch(joinPath(`/admin/manual-subscription/history?${bust}`), {
    ...ADMIN_FETCH_DEFAULTS,
    headers: adminPanelApiHeaders(),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function postManualSubscriptionBlock(deviceId) {
  const res = await fetch(joinPath('/admin/manual-subscription/block'), {
    ...ADMIN_FETCH_DEFAULTS,
    method: 'POST',
    headers: adminPanelApiHeaders(),
    body: JSON.stringify({ device_id: String(deviceId ?? '').trim() }),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function postManualSubscriptionUnblock(deviceId) {
  const res = await fetch(joinPath('/admin/manual-subscription/unblock'), {
    ...ADMIN_FETCH_DEFAULTS,
    method: 'POST',
    headers: adminPanelApiHeaders(),
    body: JSON.stringify({ device_id: String(deviceId ?? '').trim() }),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function deleteManualSubscriptionGrant(grantId, { securityPin } = {}) {
  const id = Number(grantId)
  const res = await fetch(joinPath(`/admin/manual-subscription/history/${encodeURIComponent(String(id))}`), {
    ...ADMIN_FETCH_DEFAULTS,
    method: 'DELETE',
    headers: adminPanelApiHeaders(),
    body: JSON.stringify({ security_pin: String(securityPin ?? '').trim() }),
  })
  const body = res.status === 204 ? null : await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function postManualSubscriptionHistoryDeleteAll({ securityPin, confirm = true }) {
  const res = await fetch(joinPath('/admin/manual-subscription/history/delete-all'), {
    ...ADMIN_FETCH_DEFAULTS,
    method: 'POST',
    headers: adminPanelApiHeaders(),
    body: JSON.stringify({
      security_pin: String(securityPin ?? '').trim(),
      confirm: confirm === true,
    }),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function postOfferCodeGenerate({ durationDays, pin }) {
  const res = await fetch(joinPath('/admin/offer-codes/generate'), {
    ...ADMIN_FETCH_DEFAULTS,
    method: 'POST',
    headers: adminPanelApiHeaders(),
    body: JSON.stringify({
      duration_days: Number(durationDays),
      pin: String(pin ?? ''),
    }),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function getOfferCodesHistory() {
  const res = await fetch(joinPath('/admin/offer-codes/history'), {
    ...ADMIN_FETCH_DEFAULTS,
    headers: adminPanelApiHeaders(),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function postOfferCodeBlock(code) {
  const res = await fetch(joinPath('/admin/offer-codes/block'), {
    ...ADMIN_FETCH_DEFAULTS,
    method: 'POST',
    headers: adminPanelApiHeaders(),
    body: JSON.stringify({ code: String(code ?? '').trim() }),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function postOfferCodeUnblock(code) {
  const res = await fetch(joinPath('/admin/offer-codes/unblock'), {
    ...ADMIN_FETCH_DEFAULTS,
    method: 'POST',
    headers: adminPanelApiHeaders(),
    body: JSON.stringify({ code: String(code ?? '').trim() }),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function deleteOfferCode(code) {
  const c = String(code ?? '').trim()
  const res = await fetch(joinPath(`/admin/offer-codes/${encodeURIComponent(c)}`), {
    ...ADMIN_FETCH_DEFAULTS,
    method: 'DELETE',
    headers: adminPanelApiHeaders(),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function postManualSubscriptionBulkBlock({ deviceIds, securityPin }) {
  const res = await fetch(joinPath('/admin/manual-subscription/bulk-block'), {
    ...ADMIN_FETCH_DEFAULTS,
    method: 'POST',
    headers: adminPanelApiHeaders(),
    body: JSON.stringify({
      device_ids: Array.isArray(deviceIds) ? deviceIds : [],
      security_pin: String(securityPin ?? '').trim(),
    }),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function postManualSubscriptionBulkUnblock({ deviceIds, securityPin }) {
  const res = await fetch(joinPath('/admin/manual-subscription/bulk-unblock'), {
    ...ADMIN_FETCH_DEFAULTS,
    method: 'POST',
    headers: adminPanelApiHeaders(),
    body: JSON.stringify({
      device_ids: Array.isArray(deviceIds) ? deviceIds : [],
      security_pin: String(securityPin ?? '').trim(),
    }),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function postManualSubscriptionHistoryBulkDelete({ grantIds, securityPin }) {
  const res = await fetch(joinPath('/admin/manual-subscription/history/bulk-delete'), {
    ...ADMIN_FETCH_DEFAULTS,
    method: 'POST',
    headers: adminPanelApiHeaders(),
    body: JSON.stringify({
      grant_ids: Array.isArray(grantIds) ? grantIds : [],
      security_pin: String(securityPin ?? '').trim(),
    }),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function postOfferCodesBulkBlock({ codes, securityPin }) {
  const res = await fetch(joinPath('/admin/offer-codes/bulk-block'), {
    ...ADMIN_FETCH_DEFAULTS,
    method: 'POST',
    headers: adminPanelApiHeaders(),
    body: JSON.stringify({
      codes: Array.isArray(codes) ? codes : [],
      security_pin: String(securityPin ?? '').trim(),
    }),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function postOfferCodesBulkUnblock({ codes, securityPin }) {
  const res = await fetch(joinPath('/admin/offer-codes/bulk-unblock'), {
    ...ADMIN_FETCH_DEFAULTS,
    method: 'POST',
    headers: adminPanelApiHeaders(),
    body: JSON.stringify({
      codes: Array.isArray(codes) ? codes : [],
      security_pin: String(securityPin ?? '').trim(),
    }),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function postOfferCodesBulkDelete({ codes, securityPin }) {
  const res = await fetch(joinPath('/admin/offer-codes/bulk-delete'), {
    ...ADMIN_FETCH_DEFAULTS,
    method: 'POST',
    headers: adminPanelApiHeaders(),
    body: JSON.stringify({
      codes: Array.isArray(codes) ? codes : [],
      security_pin: String(securityPin ?? '').trim(),
    }),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export function syncStreamUrl(topics = ['analytics']) {
  const normalized = Array.isArray(topics)
    ? topics.map((x) => String(x || '').trim()).filter(Boolean)
    : []
  const q = encodeURIComponent(normalized.length ? normalized.join(',') : 'analytics')
  return `${API_BASE}/sync/stream?topics=${q}`
}

/** --- Notifications --- */
export const getNotifications = () => adminApiGet('/notifications')
export const getRuntimeNotifications = (audience = 'all') =>
  apiGet(`/notifications/runtime?audience=${encodeURIComponent(String(audience || 'all'))}`)
export const postNotification = (body) => adminApiPost('/notifications', body)
export async function prepareNotificationImage(file) {
  const formData = new FormData()
  formData.append('image', file)
  const res = await fetch(joinPath('/notifications/prepare-image'), {
    ...ADMIN_FETCH_DEFAULTS,
    method: 'POST',
    headers: adminPanelFormDataHeaders(),
    body: formData,
  })
  const parsed = await parseJsonSafe(res)
  if (!res.ok) {
    throw new ApiError(msgFromBody(parsed, res.status), res.status, parsed)
  }
  return parsed
}
export const getOnesignalDiagnostics = () => adminApiGet('/notifications/onesignal-diagnostics')
export const putNotification = (id, body) => adminApiPut(`/notifications/${encodeURIComponent(id)}`, body)
export const syncNotificationStats = (id) =>
  adminApiPost(`/notifications/${encodeURIComponent(id)}/sync-stats`, {})
export const deleteNotification = (id) => adminApiDelete(`/notifications/${encodeURIComponent(id)}`)
export const deleteAllNotifications = () => adminApiRequest('/notifications/all', { method: 'DELETE' })

/** --- Transfer codes --- */
export const getTransferCodes = () => adminApiGet('/transfer-codes')
export const postTransferCode = (body) => adminApiPost('/transfer-codes', body)
export const postAdminForceTransferPhone = (body) => adminApiPost('/transfer/admin-force-phone', body)
export const putTransferCode = (id, body) => adminApiPut(`/transfer-codes/${encodeURIComponent(id)}`, body)
export const deleteTransferCode = (id) => adminApiDelete(`/transfer-codes/${encodeURIComponent(id)}`)
export const postTransferCodesBulkDelete = (body) => adminApiPost('/transfer-codes/bulk-delete', body)

/** --- Settings docs --- */
export const getZenopaySettings = () => adminApiGet('/settings/zenopay')
export const putZenopaySettings = (body) => adminApiPut('/settings/zenopay', body)
export const postZenopayTest = (body) => adminApiPost('/settings/zenopay/test', body)

export const getSonicpesaSettings = () => adminApiGet('/settings/sonicpesa')
export const putSonicpesaSettings = (body) => adminApiPut('/settings/sonicpesa', body)
export const postSonicpesaTest = (body = {}) => adminApiPost('/settings/sonicpesa/test', body)
export const getAuraxpaySettings = () => adminApiGet('/settings/auraxpay')
export const putAuraxpaySettings = (body) => adminApiPut('/settings/auraxpay', body)
export const postAuraxpayTest = (body = {}) => adminApiPost('/settings/auraxpay/test', body)
export const getPaymentProvidersSettings = () => adminApiGet('/settings/payment-providers')
export const getPaymentProviders = () => apiGet('/payment-providers')
export const postPaymentProviderFormData = (formData) =>
  fetch(joinPath('/settings/payment-providers'), {
    ...ADMIN_FETCH_DEFAULTS,
    method: 'POST',
    headers: adminPanelFormDataHeaders(),
    body: formData,
  }).then(parseJsonSafeResponse)
export const putPaymentProviderFormData = (id, formData) =>
  fetch(joinPath(`/settings/payment-providers/${encodeURIComponent(id)}`), {
    ...ADMIN_FETCH_DEFAULTS,
    method: 'PUT',
    headers: adminPanelFormDataHeaders(),
    body: formData,
  }).then(parseJsonSafeResponse)
export const deletePaymentProvider = (id) =>
  adminApiDelete(`/settings/payment-providers/${encodeURIComponent(id)}`)

export const getWhatsappSettings = () => adminApiGet('/whatsapp-settings')
export const putWhatsappSettings = (body) => adminApiPut('/whatsapp-settings', body)

export const getBeemSettings = () => adminApiGet('/settings/beem')
export const putBeemSettings = (body) => adminApiPut('/settings/beem', body)
export const postBeemTest = (body = {}) => adminApiPost('/settings/beem/test', body)
export const getSmsTemplates = () => adminApiGet('/admin/sms/templates')
export const putSmsTemplate = (key, body) => adminApiPut(`/admin/sms/templates/${encodeURIComponent(key)}`, body)
export const getSmsLog = (params = {}) => {
  const q = new URLSearchParams()
  if (params.limit != null) q.set('limit', String(params.limit))
  if (params.offset != null) q.set('offset', String(params.offset))
  if (params.search) q.set('search', String(params.search))
  if (params.status) q.set('status', String(params.status))
  if (params.trigger) q.set('trigger', String(params.trigger))
  if (params.recipient) q.set('recipient', String(params.recipient))
  if (params.date_from) q.set('date_from', String(params.date_from))
  if (params.date_to) q.set('date_to', String(params.date_to))
  const qs = q.toString()
  return adminApiGet(`/admin/sms/log${qs ? `?${qs}` : ''}`)
}
export const getSmsLogById = (id) => adminApiGet(`/admin/sms/log/${encodeURIComponent(id)}`)
export const postSmsLogResend = (id) => adminApiPost(`/admin/sms/log/${encodeURIComponent(id)}/resend`, {})
export const getSmsRecipientCounts = () => adminApiGet('/admin/sms/recipients/counts')
export const postSmsSend = (body) => adminApiPost('/admin/sms/send', body)

export const getAppUpdateSettings = () => adminApiGet('/settings/app-update')
export const putAppUpdateSettings = (body) => adminApiPut('/settings/app-update', body)
export const getUpdateCheck = (versionCode) =>
  apiGet(`/update-check${versionCode != null ? `?version_code=${encodeURIComponent(versionCode)}` : ''}`)
export const getAppVersionMigrationStats = ({ search = '', limit = 25, offset = 0 } = {}) => {
  const q = new URLSearchParams()
  if (search) q.set('q', search)
  if (limit != null) q.set('limit', String(limit))
  if (offset != null) q.set('offset', String(offset))
  const qs = q.toString()
  return adminApiGet(`/admin/app-version-migration/stats${qs ? `?${qs}` : ''}`)
}

/** Fetch title, versionName, and package id from a Google Play Store listing URL. */
export const postAppUpdateParsePlayStore = (url, { persist = true } = {}) =>
  adminApiPost('/settings/app-update/parse-playstore', { url, persist })

/**
 * Upload APK to server storage (multipart). Reports upload progress 0–100 via onProgress.
 */
export function postAppUpdateApkUpload(file, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new ApiError('No APK file selected', 400, null))
      return
    }
    const formData = new FormData()
    formData.append('apk', file)
    const xhr = new XMLHttpRequest()
    xhr.open('POST', joinPath('/settings/app-update/upload-apk'))
    const headers = adminPanelApiHeaders()
    Object.entries(headers).forEach(([key, value]) => {
      if (key.toLowerCase() !== 'content-type') xhr.setRequestHeader(key, value)
    })
    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable || typeof onProgress !== 'function') return
      onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)))
    })
    xhr.addEventListener('load', () => {
      let body = null
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null
      } catch {
        body = xhr.responseText
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body)
        return
      }
      reject(new ApiError(msgFromBody(body, xhr.status), xhr.status, body))
    })
    xhr.addEventListener('error', () => {
      reject(new ApiError('APK upload failed (network error)', 0, null))
    })
    xhr.addEventListener('abort', () => {
      reject(new ApiError('APK upload cancelled', 0, null))
    })
    xhr.send(formData)
  })
}

export const getPopupSettings = () => adminApiGet('/popup-settings')
export const putPopupSettings = (body) => adminApiPut('/popup-settings', body)
export const getRuntimePopupSettings = () => apiGet('/settings/popup')
export const putRuntimePopupSettings = (body) => adminApiPut('/settings/popup', body)

export const getDeviceControlSettings = () => adminApiGet('/settings/device-control')
export const putDeviceControlSettings = (body) => adminApiPut('/settings/device-control', body)

export const getSecuritySuite = () => adminApiGet('/settings/security-suite')
export const putSecuritySuite = (body) => adminApiPut('/settings/security-suite', body)
export const postSecuritySuiteRestoreWhitelist = () =>
  adminApiPost('/settings/security-suite/restore-whitelist', {})
export const deleteSecurityAlert = (id) =>
  adminApiDelete(`/settings/security-suite/alerts/${encodeURIComponent(id)}`)
export const postSecurityAlertsBulkDelete = (body) =>
  adminApiPost('/settings/security-suite/alerts/bulk-delete', body)

export const getSecurityLogs = () => adminApiGet('/security-logs')
export const postSecurityLog = (entry) => adminApiPost('/security-logs', entry)
export const deleteSecurityLog = (id) => adminApiDelete(`/security-logs/${encodeURIComponent(id)}`)
export const postSecurityLogsBulkDelete = (body) => adminApiPost('/security-logs/bulk-delete', body)

export const getSecurityStats = () => adminApiGet('/security/stats')
export const getSecurityRiskDevices = (params = {}) => {
  const q = new URLSearchParams()
  if (params.q) q.set('q', params.q)
  if (params.level) q.set('level', params.level)
  if (params.limit) q.set('limit', String(params.limit))
  const qs = q.toString()
  return adminApiGet(`/security/devices${qs ? `?${qs}` : ''}`)
}
export const getSecurityRiskDevice = (deviceId) =>
  adminApiGet(`/security/devices/${encodeURIComponent(deviceId)}`)
export const getSecurityDeviceInvestigation = (deviceId) =>
  adminApiGet(`/security/devices/${encodeURIComponent(deviceId)}/investigation`)
export const getSecurityDeviceVerification = (deviceId) =>
  adminApiGet(`/security/devices/${encodeURIComponent(deviceId)}/verification`)
export const postSecurityDeviceAction = (deviceId, body) =>
  adminApiPost(`/security/devices/${encodeURIComponent(deviceId)}/action`, body)
export const postSecurityDevicesBulkAction = (body) =>
  adminApiPost('/security/devices/bulk-action', body)

export const postRuntimeSecurityReport = (body) =>
  apiPost('/runtime/security-report', body)

export const getDashboard = () => apiGet('/dashboard')
export const putDashboardSettings = (body) => apiPut('/settings/dashboard', body)

export const getAnalyticsOverview = () => apiGet('/analytics/overview')
export const getAnalyticsSnapshot = () => apiGet('/analytics/snapshot')
export const getAnalyticsChannels = () => apiGet('/analytics/channels')
export const getAnalyticsLocations = () => apiGet('/analytics/locations')
export const getAnalyticsTrend = () => apiGet('/analytics/trend')

export const getAnalyticsResetInstallsStatus = () =>
  adminApiGet('/admin/analytics/reset-installs/status')
export const postAnalyticsResetVerifyPassword = (body) =>
  adminApiPost('/admin/analytics/reset-installs/verify-password', body)
export const postAnalyticsResetSendOtp = (body) =>
  adminApiPost('/admin/analytics/reset-installs/send-otp', body)
export const postAnalyticsResetResendOtp = (body) =>
  adminApiPost('/admin/analytics/reset-installs/resend-otp', body)
export const postAnalyticsResetExecute = (body) =>
  adminApiPost('/admin/analytics/reset-installs/execute', body)
export const getServerHealth = () => adminApiGet('/server-health')
export const getApiHealth = () => apiGet('/health')
export const getAdminPanelDiagnostics = () => adminApiGet('/admin/panel-diagnostics')

export const getUsersIntelligenceList = (q) => {
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  const qs = params.toString()
  return adminApiGet(qs ? `/admin/users-intelligence?${qs}` : '/admin/users-intelligence')
}
export const getUsersIntelligenceSummary = () => adminApiGet('/admin/users-intelligence/summary')
export const getUsersIntelligenceDetail = (id) =>
  adminApiGet(`/admin/users-intelligence/${encodeURIComponent(id)}`)
export const postUsersIntelligenceBlock = (id, body) =>
  adminApiPost(`/admin/users-intelligence/${encodeURIComponent(id)}/block`, body)
export const postUsersIntelligenceUnblock = (id, body) =>
  adminApiPost(`/admin/users-intelligence/${encodeURIComponent(id)}/unblock`, body)
export const postUsersIntelligenceBackfill = () => adminApiPost('/admin/users-intelligence/backfill', {})
export const postUsersIntelligenceSyncBlocks = () =>
  adminApiPost('/admin/users-intelligence/sync-blocks', {})

export const getCustomerInvestigation = (q) =>
  adminApiGet(`/admin/customer-investigation?q=${encodeURIComponent(q)}`)
export const postCustomerInvestigationReconcile = (body) =>
  adminApiPost('/admin/customer-investigation/actions/reconcile', body)
export const postCustomerInvestigationActivate = (body) =>
  adminApiPost('/admin/customer-investigation/actions/activate-completed', body)
export const postCustomerInvestigationRefreshSubscription = (body) =>
  adminApiPost('/admin/customer-investigation/actions/refresh-subscription', body)

/** --- Payment orders ledger --- */
export const getPaymentOrders = (params = {}) => {
  const q = new URLSearchParams()
  if (params.status) q.set('status', params.status)
  if (params.provider) q.set('provider', params.provider)
  if (params.search) q.set('search', params.search)
  if (params.limit != null) q.set('limit', String(params.limit))
  if (params.page != null) q.set('page', String(params.page))
  if (params.offset != null) q.set('offset', String(params.offset))
  const s = q.toString()
  return adminApiGet(s ? `/admin/payment-orders?${s}` : '/admin/payment-orders')
}
export const getPaymentOrderDetail = (orderId) =>
  adminApiGet(`/admin/payment-orders/${encodeURIComponent(orderId)}`)
export const postPaymentOrderApproveRecovery = (orderId, body) =>
  adminApiPost(`/admin/payment-orders/${encodeURIComponent(orderId)}/approve-recovery`, body)
export const postPaymentOrderRecover = (orderId, body) =>
  adminApiPost(`/admin/payment-orders/${encodeURIComponent(orderId)}/recover`, body)
export const getPaymentOrderRecoveryEligibility = (orderId) =>
  adminApiGet(`/admin/payment-orders/${encodeURIComponent(orderId)}/recovery-eligibility`)
export const postPaymentOrderRejectRecovery = (orderId, body) =>
  adminApiPost(`/admin/payment-orders/${encodeURIComponent(orderId)}/reject-recovery`, body)
export const postPaymentOrderReconcile = (orderId, body) =>
  adminApiPost(`/admin/payment-orders/${encodeURIComponent(orderId)}/reconcile`, body)

/** --- Subscription requests (OMBA KIFURUSHI CHAKO) --- */
export const getSubscriptionRequests = (params = {}) => {
  const q = new URLSearchParams()
  if (params.status) q.set('status', params.status)
  if (params.search) q.set('search', params.search)
  const s = q.toString()
  return adminApiGet(s ? `/admin/subscription-requests?${s}` : '/admin/subscription-requests')
}
export const getSubscriptionRequestSettings = () => adminApiGet('/admin/subscription-requests/settings')
export const putSubscriptionRequestSettings = (body) =>
  adminApiPut('/admin/subscription-requests/settings', body)
export const postSubscriptionRequestApprove = (id, body) =>
  adminApiPost(`/admin/subscription-requests/${encodeURIComponent(id)}/approve`, body)
export const postSubscriptionRequestReject = (id, body) =>
  adminApiPost(`/admin/subscription-requests/${encodeURIComponent(id)}/reject`, body)
export const postSubscriptionRequestBlock = (id, body) =>
  adminApiPost(`/admin/subscription-requests/${encodeURIComponent(id)}/block`, body)
export const postSubscriptionRequestDelete = (id, body) =>
  adminApiPost(`/admin/subscription-requests/${encodeURIComponent(id)}/delete`, body)
export const postSubscriptionRequestsBulkDelete = (body) =>
  adminApiPost('/admin/subscription-requests/bulk-delete', body)
