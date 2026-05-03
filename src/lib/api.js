const ORIGIN =
  (import.meta.env.VITE_API_BASE_URL && String(import.meta.env.VITE_API_BASE_URL).replace(/\/$/, '')) ||
  'https://osmani-tv.onrender.com'

export const API_ORIGIN = ORIGIN
export const API_BASE = `${ORIGIN}/api`

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

export function deleteChannel(id) {
  return apiDelete(`/channels/${encodeURIComponent(id)}`)
}

/** --- Banners --- */
export const getBanners = () => apiGet('/banners')
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
export const deleteUser = (id) => apiDelete(`/users/${encodeURIComponent(id)}`)

/** --- Transactions --- */
export const getTransactions = () => apiGet('/transactions')

/** --- Notifications --- */
export const getNotifications = () => apiGet('/notifications')
export const postNotification = (body) => apiPost('/notifications', body)
export const putNotification = (id, body) => apiPut(`/notifications/${encodeURIComponent(id)}`, body)

/** --- Transfer codes --- */
export const getTransferCodes = () => apiGet('/transfer-codes')
export const postTransferCode = (body) => apiPost('/transfer-codes', body)
export const putTransferCode = (id, body) => apiPut(`/transfer-codes/${encodeURIComponent(id)}`, body)
export const deleteTransferCode = (id) => apiDelete(`/transfer-codes/${encodeURIComponent(id)}`)

/** --- Settings docs --- */
export const getZenopaySettings = () => apiGet('/settings/zenopay')
export const putZenopaySettings = (body) => apiPut('/settings/zenopay', body)
export const postZenopayTest = (body) => apiPost('/settings/zenopay/test', body)

export const getWhatsappSettings = () => apiGet('/settings/whatsapp')
export const putWhatsappSettings = (body) => apiPut('/settings/whatsapp', body)

export const getAppUpdateSettings = () => apiGet('/settings/app-update')
export const putAppUpdateSettings = (body) => apiPut('/settings/app-update', body)

export const getPopupSettings = () => apiGet('/settings/popup')
export const putPopupSettings = (body) => apiPut('/settings/popup', body)

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

export const getAnalyticsSummary = () => apiGet('/analytics/summary')
export const getServerHealth = () => apiGet('/server-health')
export const getApiHealth = () => apiGet('/health')
