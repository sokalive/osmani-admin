import { LS_SECURITY_SUITE } from '../constants/storageKeys'
import { generateSecurityAlerts } from './securityAlertsSeed'

const LEGACY_ALERTS_KEY = 'osmani_security_alerts_v1'

function id() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `w-${Date.now()}`
}

export function generateDefaultWhitelist() {
  return [
    { id: id(), value: '102.90.12.44 · Head office' },
    { id: id(), value: '41.59.21.88 · CDN edge' },
    { id: id(), value: 'Pixel 8 · +255712000001' },
    { id: id(), value: 'TV-Box A12 · living-room' },
    { id: id(), value: 'api.osmani.tv · health probe' },
    { id: id(), value: '197.250.8.1 · Partner POP' },
  ]
}

export function generateBlockedUsers(count = 5) {
  const phones = ['+255744112233', '+255622998877', '+255713445566', '+255699001122', '+255788334455']
  const reasons = ['Velocity abuse', 'Payment fraud flag', 'Credential stuffing', 'Geo anomaly', 'Token replay']
  const out = []
  for (let i = 0; i < count; i++) {
    out.push({
      id: id(),
      phone: phones[i % phones.length],
      reason: reasons[i % reasons.length],
      blockedAt: new Date(Date.now() - Math.random() * 86400000 * 6).toISOString(),
    })
  }
  return out
}

function normalizeAlert(a) {
  return {
    ...a,
    kind: a.kind || 'login',
  }
}

export function normalizeSuite(raw) {
  const base = defaultSecuritySuite()
  if (!raw || typeof raw !== 'object') return base
  return {
    protectionMode: raw.protectionMode === 'automatic' ? 'automatic' : 'manual',
    whitelist: Array.isArray(raw.whitelist) && raw.whitelist.length ? raw.whitelist : base.whitelist,
    blockedUsers:
      Array.isArray(raw.blockedUsers) && raw.blockedUsers.length ? raw.blockedUsers : base.blockedUsers,
    alerts: Array.isArray(raw.alerts)
      ? raw.alerts.map(normalizeAlert)
      : base.alerts,
  }
}

export function defaultSecuritySuite() {
  return {
    protectionMode: 'manual',
    whitelist: generateDefaultWhitelist(),
    blockedUsers: generateBlockedUsers(5),
    alerts: generateSecurityAlerts(14),
  }
}

/**
 * One-time migration from legacy alerts-only storage; ensures full suite shape.
 */
export function initializeSecuritySuite() {
  try {
    const v = localStorage.getItem(LS_SECURITY_SUITE)
    if (v) {
      return normalizeSuite(JSON.parse(v))
    }
    const old = localStorage.getItem(LEGACY_ALERTS_KEY)
    const base = defaultSecuritySuite()
    if (old) {
      const parsed = JSON.parse(old)
      const alerts = Array.isArray(parsed) ? parsed.map(normalizeAlert) : base.alerts
      const merged = {
        ...base,
        alerts: alerts.length ? alerts : base.alerts,
      }
      localStorage.setItem(LS_SECURITY_SUITE, JSON.stringify(merged))
      try {
        localStorage.removeItem(LEGACY_ALERTS_KEY)
      } catch {
        /* ignore */
      }
      return merged
    }
  } catch {
    /* fall through */
  }
  return defaultSecuritySuite()
}
