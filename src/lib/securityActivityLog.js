import { postSecurityLog } from './api'

/**
 * Append security log via API (immutable history).
 * @param {{ actor: string, eventType: string, status: 'completed'|'failed', detail?: string }} entry
 */
export async function appendSecurityLog(entry) {
  try {
    await postSecurityLog({
      actor: entry.actor ?? 'System',
      eventType: entry.eventType,
      status: entry.status,
      detail: entry.detail ?? '',
    })
  } catch {
    /* ignore */
  }
}

/** @deprecated kept for compatibility; use appendSecurityLog only */
export const SECURITY_LOGS_SYNC = 'osmani-security-logs-sync'
