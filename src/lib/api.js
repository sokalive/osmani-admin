import { getAdminDeviceFingerprintRaw } from './adminDeviceFingerprint'
import { bannerSaveBody } from './bannerSaveBody.js'

const API_BASE_ENV = String(
  import.meta.env.VITE_API_URL || import.meta.env.VITE_API_BASE_URL || '',
).trim()

function normalizeApiBase(raw) {
  const fallback = 'https://osmani-admin-api.onrender.com/api'
  const s = String(raw || '').trim()
  if (!s) return fallback
  const clean = s.replace(/\/$/, '')
  if (/\/api$/i.test(clean)) return clean
  return `${clean}/api`
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

/** Global app modes (Free / Emergency / Maintenance) — GET/PUT /api/settings */
export const getAppGlobalSettings = () => adminApiGet('/settings')
export const putAppGlobalSettings = (body) => adminApiPut('/settings', body)

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
export const deleteBanner = (id) => adminApiDelete(`/banners/${encodeURIComponent(id)}`)

/** --- Plans --- (GET public for Android checkout; mutations require admin session/token) */
export const getPlans = () => apiGet('/plans')
export const postPlan = (body) => adminApiPost('/plans', body)
export const putPlan = (id, body) => adminApiPut(`/plans/${encodeURIComponent(id)}`, body)
export const deletePlan = (id) => adminApiDelete(`/plans/${encodeURIComponent(id)}`)

/** --- Users --- (admin-only; drives subscription rows — Android notified via SSE + subscription-stream) */
export const getUsers = () => adminApiGet('/users')
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

/** Public: which checkout providers are available (ZenoPay always if configured; SonicPesa only if enabled + configured). */
export const getCheckoutPaymentProviders = () => apiGet('/payments/checkout-providers')

/** Initiate SonicPesa payment (separate from ZenoPay; tags transaction as sonicpesa). */
export const postSonicpesaCreateOrder = (body) => apiPost('/payments/sonicpesa/create-order', body)

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
  if (typeof sessionStorage !== 'undefined') {
    const jwt = sessionStorage.getItem('osmani_admin_token')
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

export async function adminApiRequest(path, { method = 'GET', body, allowNoContent = false } = {}) {
  const res = await fetch(joinPath(path), {
    ...ADMIN_FETCH_DEFAULTS,
    method,
    headers: adminPanelApiHeaders(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const parsed = res.status === 204 && allowNoContent ? null : await parseJsonSafe(res)
  if (!res.ok && !(allowNoContent && res.status === 204)) {
    throw new ApiError(msgFromBody(parsed, res.status), res.status, parsed)
  }
  return parsed
}

export function adminApiGet(path) {
  return adminApiRequest(path)
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

/** Admin: grant stacked subscription days (PIN validated only on server). */
export async function postManualSubscriptionGrant({ deviceId, durationDays, pin }) {
  const res = await fetch(joinPath('/admin/manual-subscription/grant'), {
    ...ADMIN_FETCH_DEFAULTS,
    method: 'POST',
    headers: adminPanelApiHeaders(),
    body: JSON.stringify({
      device_id: String(deviceId ?? '').trim(),
      duration_days: Number(durationDays),
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

export async function deleteManualSubscriptionGrant(grantId) {
  const id = Number(grantId)
  const res = await fetch(joinPath(`/admin/manual-subscription/history/${encodeURIComponent(String(id))}`), {
    ...ADMIN_FETCH_DEFAULTS,
    method: 'DELETE',
    headers: adminPanelApiHeaders(),
  })
  const body = res.status === 204 ? null : await parseJsonSafe(res)
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
export const getOnesignalDiagnostics = () => adminApiGet('/notifications/onesignal-diagnostics')
export const putNotification = (id, body) => adminApiPut(`/notifications/${encodeURIComponent(id)}`, body)
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

export const getAppUpdateSettings = () => adminApiGet('/settings/app-update')
export const putAppUpdateSettings = (body) => adminApiPut('/settings/app-update', body)
export const getUpdateCheck = () => apiGet('/update-check')

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
export const postSecurityDeviceAction = (deviceId, body) =>
  adminApiPost(`/security/devices/${encodeURIComponent(deviceId)}/action`, body)
export const postSecurityDevicesBulkAction = (body) =>
  adminApiPost('/security/devices/bulk-action', body)

export const postRuntimeSecurityReport = (body) =>
  apiPost('/runtime/security-report', body)

export const getDashboard = () => apiGet('/dashboard')
export const putDashboardSettings = (body) => apiPut('/settings/dashboard', body)

export const getAnalyticsOverview = () => apiGet('/analytics/overview')
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
