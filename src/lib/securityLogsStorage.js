import { LS_SECURITY_LOGS } from '../constants/storageKeys'
import { generateSecurityLogs } from '../data/securityLogsSeed'

export function loadSecurityLogsFromStorage() {
  try {
    const raw = localStorage.getItem(LS_SECURITY_LOGS)
    if (raw) {
      const list = JSON.parse(raw)
      if (Array.isArray(list) && list.length > 0) return list
    }
  } catch {
    /* ignore */
  }
  const seed = generateSecurityLogs(14)
  try {
    localStorage.setItem(LS_SECURITY_LOGS, JSON.stringify(seed))
  } catch {
    /* quota */
  }
  return seed
}
