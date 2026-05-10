import { getAdminDeviceFingerprintRaw } from './adminDeviceFingerprint'

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
  const res = await fetch(joinPath(path))
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
  return apiPost('/channels', data)
}

export function updateChannel(id, data) {
  return apiPut(`/channels/${encodeURIComponent(id)}`, data)
}

export function addChannelFormData(formData) {
  return fetch(joinPath('/channels'), {
    method: 'POST',
    body: formData,
  }).then(parseJsonSafeResponse)
}

export function updateChannelFormData(id, formData) {
  return fetch(joinPath(`/channels/${encodeURIComponent(id)}`), {
    method: 'PUT',
    body: formData,
  }).then(parseJsonSafeResponse)
}

export function deleteChannel(id) {
  return apiDelete(`/channels/${encodeURIComponent(id)}`)
}

/** Global app modes (Free / Emergency / Maintenance) — GET/PUT /api/settings */
export const getAppGlobalSettings = () => apiGet('/settings')
export const putAppGlobalSettings = (body) => apiPut('/settings', body)

/** --- Banners --- */
/** Public list (active + enabled + schedule). */
export const getBanners = () => apiGet('/banners')
/** Full list for admin CMS. */
export const getBannersManage = () => apiGet('/banners/manage')
export const postBanner = (body) => apiPost('/banners', body)
export const putBanner = (id, body) => apiPut(`/banners/${encodeURIComponent(id)}`, body)
export const deleteBanner = (id) => apiDelete(`/banners/${encodeURIComponent(id)}`)

/** --- Plans --- */
export const getPlans = () => apiGet('/plans')
export const postPlan = (body) => apiPost('/plans', body)
export const putPlan = (id, body) => apiPut(`/plans/${encodeURIComponent(id)}`, body)
export const deletePlan = (id) => apiDelete(`/plans/${encodeURIComponent(id)}`)

/** --- Users --- */
export const getUsers = () => apiGet('/users')
export const postUser = (body) => apiPost('/users', body)
export const putUser = (id, body) => apiPut(`/users/${encodeURIComponent(id)}`, body)
export const deleteUser = (id, { force = false } = {}) => {
  const path = force
    ? `/users/${encodeURIComponent(id)}?force=true`
    : `/users/${encodeURIComponent(id)}`
  return apiDelete(path)
}

/** --- Transactions --- (optional server-side filters) */
export function getTransactions(params = {}) {
  const q = new URLSearchParams()
  if (params.status && params.status !== 'all') q.set('status', params.status)
  if (params.from) q.set('from', params.from)
  if (params.to) q.set('to', params.to)
  const s = q.toString()
  return apiGet(s ? `/transactions?${s}` : '/transactions')
}
export async function deleteTransactionsBulk(ids) {
  const res = await fetch(joinPath('/transactions/bulk'), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: Array.isArray(ids) ? ids : [] }),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

/** Initiate ZenoPay collection (uses server-stored credentials + env overrides). */
export const postCreatePayment = (body) => apiPost('/payments/create-payment', body)

/** Poll payment status: { order_id, status } where status is SUCCESS | PENDING | FAILED */
export const getPaymentStatus = (orderId) =>
  apiGet(`/payment-status/${encodeURIComponent(String(orderId ?? ''))}`)

/** Device subscription unlock (polling fallback). Prefer SSE `subscription-stream` for realtime. */
export const getSubscriptionStatus = (deviceId) =>
  apiGet(`/subscription-status?device_id=${encodeURIComponent(String(deviceId ?? '').trim())}`)

export function subscriptionStreamUrl(deviceId) {
  const d = encodeURIComponent(String(deviceId ?? '').trim())
  return `${API_BASE}/subscription-stream?device_id=${d}`
}

/** Mobile: dismiss one-time manual gift popup after user taps ASANTE */
export const postAcknowledgeManualGift = (body) =>
  apiPost('/subscription/acknowledge-manual-gift', body)

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

/**
 * Probe panel auth gate. Never throws: use when bootstrapping the SPA so a missing
 * `/admin/auth/status` (404) or network error cannot blank the shell.
 */
export async function getAdminAuthStatus() {
  try {
    const res = await fetch(joinPath('/admin/auth/status'))
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

export async function getAdminAuthDevices() {
  const res = await fetch(joinPath('/admin/auth/devices'), {
    headers: adminPanelApiHeaders(),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function postVerifyAdminSecurityPin(securityPin) {
  const res = await fetch(joinPath('/admin/auth/verify-security-pin'), {
    method: 'POST',
    headers: adminPanelApiHeaders(),
    body: JSON.stringify({ security_pin: String(securityPin ?? '').trim() }),
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
    method: 'POST',
    headers: adminPanelApiHeaders(),
    body: adminTrustedDeviceMutationBody(opts),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function postAdminDeviceUnblock(id, opts = {}) {
  const res = await fetch(joinPath(`/admin/auth/devices/${encodeURIComponent(id)}/unblock`), {
    method: 'POST',
    headers: adminPanelApiHeaders(),
    body: adminTrustedDeviceMutationBody(opts),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function deleteAdminTrustedDevice(id, opts = {}) {
  const res = await fetch(joinPath(`/admin/auth/devices/${encodeURIComponent(id)}`), {
    method: 'DELETE',
    headers: adminPanelApiHeaders(),
    body: adminTrustedDeviceMutationBody(opts),
  })
  const body = res.status === 204 ? null : await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function postAdminDeviceForceOtp(id, opts = {}) {
  const res = await fetch(joinPath(`/admin/auth/devices/${encodeURIComponent(id)}/force-otp`), {
    method: 'POST',
    headers: adminPanelApiHeaders(),
    body: adminTrustedDeviceMutationBody(opts),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

/** Admin: grant stacked subscription days (PIN validated only on server). */
export async function postManualSubscriptionGrant({ deviceId, durationDays, pin }) {
  const res = await fetch(joinPath('/admin/manual-subscription/grant'), {
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
  const res = await fetch(joinPath('/admin/manual-subscription/history'), {
    headers: adminPanelApiHeaders(),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function postManualSubscriptionBlock(deviceId) {
  const res = await fetch(joinPath('/admin/manual-subscription/block'), {
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
    method: 'DELETE',
    headers: adminPanelApiHeaders(),
  })
  const body = res.status === 204 ? null : await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function postOfferCodeGenerate({ durationDays, pin }) {
  const res = await fetch(joinPath('/admin/offer-codes/generate'), {
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
    headers: adminPanelApiHeaders(),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function postOfferCodeBlock(code) {
  const res = await fetch(joinPath('/admin/offer-codes/block'), {
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
    method: 'DELETE',
    headers: adminPanelApiHeaders(),
  })
  const body = await parseJsonSafe(res)
  if (!res.ok) throw new ApiError(msgFromBody(body, res.status), res.status, body)
  return body
}

export async function postManualSubscriptionBulkBlock({ deviceIds, securityPin }) {
  const res = await fetch(joinPath('/admin/manual-subscription/bulk-block'), {
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
export const getNotifications = () => apiGet('/notifications')
export const postNotification = (body) => apiPost('/notifications', body)
export const putNotification = (id, body) => apiPut(`/notifications/${encodeURIComponent(id)}`, body)

/** --- Transfer codes --- */
export const getTransferCodes = () => apiGet('/transfer-codes')
export const postTransferCode = (body) => apiPost('/transfer-codes', body)
export const postAdminForceTransferPhone = (body) => apiPost('/transfer/admin-force-phone', body)
export const putTransferCode = (id, body) => apiPut(`/transfer-codes/${encodeURIComponent(id)}`, body)
export const deleteTransferCode = (id) => apiDelete(`/transfer-codes/${encodeURIComponent(id)}`)
export const postTransferCodesBulkDelete = (body) => apiPost('/transfer-codes/bulk-delete', body)

/** --- Settings docs --- */
export const getZenopaySettings = () => apiGet('/settings/zenopay')
export const putZenopaySettings = (body) => apiPut('/settings/zenopay', body)
export const postZenopayTest = (body) => apiPost('/settings/zenopay/test', body)
export const getPaymentProvidersSettings = () => apiGet('/settings/payment-providers')
export const getPaymentProviders = () => apiGet('/payment-providers')
export const postPaymentProviderFormData = (formData) =>
  fetch(joinPath('/settings/payment-providers'), {
    method: 'POST',
    body: formData,
  }).then(parseJsonSafeResponse)
export const putPaymentProviderFormData = (id, formData) =>
  fetch(joinPath(`/settings/payment-providers/${encodeURIComponent(id)}`), {
    method: 'PUT',
    body: formData,
  }).then(parseJsonSafeResponse)
export const deletePaymentProvider = (id) =>
  apiDelete(`/settings/payment-providers/${encodeURIComponent(id)}`)

export const getWhatsappSettings = () => apiGet('/whatsapp-settings')
export const putWhatsappSettings = (body) => apiPut('/whatsapp-settings', body)

export const getAppUpdateSettings = () => apiGet('/settings/app-update')
export const putAppUpdateSettings = (body) => apiPut('/settings/app-update', body)

export const getPopupSettings = () => apiGet('/popup-settings')
export const putPopupSettings = (body) => apiPut('/popup-settings', body)

export const getDeviceControlSettings = () => apiGet('/settings/device-control')
export const putDeviceControlSettings = (body) => apiPut('/settings/device-control', body)

export const getSecuritySuite = () => apiGet('/settings/security-suite')
export const putSecuritySuite = (body) => apiPut('/settings/security-suite', body)
export const postSecuritySuiteRestoreWhitelist = () =>
  apiPost('/settings/security-suite/restore-whitelist', {})
export const deleteSecurityAlert = (id) =>
  apiDelete(`/settings/security-suite/alerts/${encodeURIComponent(id)}`)
export const postSecurityAlertsBulkDelete = (body) =>
  apiPost('/settings/security-suite/alerts/bulk-delete', body)

export const getSecurityLogs = () => apiGet('/security-logs')
export const postSecurityLog = (entry) => apiPost('/security-logs', entry)
export const deleteSecurityLog = (id) => apiDelete(`/security-logs/${encodeURIComponent(id)}`)
export const postSecurityLogsBulkDelete = (body) => apiPost('/security-logs/bulk-delete', body)

export const getDashboard = () => apiGet('/dashboard')
export const putDashboardSettings = (body) => apiPut('/settings/dashboard', body)

export const getAnalyticsOverview = () => apiGet('/analytics/overview')
export const getAnalyticsChannels = () => apiGet('/analytics/channels')
export const getAnalyticsLocations = () => apiGet('/analytics/locations')
export const getAnalyticsTrend = () => apiGet('/analytics/trend')
export const getServerHealth = () => apiGet('/server-health')
export const getApiHealth = () => apiGet('/health')
