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

console.log('API_BASE:', API_BASE)

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

export const getSecurityLogs = () => apiGet('/security-logs')
export const postSecurityLog = (entry) => apiPost('/security-logs', entry)

export const getDashboard = () => apiGet('/dashboard')
export const putDashboardSettings = (body) => apiPut('/settings/dashboard', body)

export const getAnalyticsOverview = () => apiGet('/analytics/overview')
export const getAnalyticsChannels = () => apiGet('/analytics/channels')
export const getAnalyticsLocations = () => apiGet('/analytics/locations')
export const getAnalyticsTrend = () => apiGet('/analytics/trend')
export const getServerHealth = () => apiGet('/server-health')
export const getApiHealth = () => apiGet('/health')
