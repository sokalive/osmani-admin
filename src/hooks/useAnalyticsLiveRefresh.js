import { useEffect, useRef } from 'react'
import { syncStreamUrl } from '../lib/api'
import { createRefreshCoordinator } from '../lib/adminRefreshCoordinator'

const ANALYTICS_SSE_DEBOUNCE_MS = 350

/**
 * Poll analytics + debounced SSE refresh (avoids thundering herd on presence_expired).
 * Dedupes overlapping poll/SSE-triggered loads.
 * @param {() => void | Promise<void>} load
 * @param {{ pollMs?: number, sse?: boolean }} [opts]
 */
export function useAnalyticsLiveRefresh(load, opts = {}) {
  const pollMs = Math.max(5000, Number(opts.pollMs) || 15_000)
  const sseEnabled = opts.sse !== false
  const loadRef = useRef(load)
  loadRef.current = load
  const coordinatorRef = useRef(null)
  if (!coordinatorRef.current) {
    coordinatorRef.current = createRefreshCoordinator(() => loadRef.current(), {
      debounceMs: ANALYTICS_SSE_DEBOUNCE_MS,
      minIntervalMs: 900,
    })
  }

  useEffect(() => {
    const coord = coordinatorRef.current
    void coord.runNow()
    const pollId = window.setInterval(() => void coord.runNow(), pollMs)
    return () => window.clearInterval(pollId)
  }, [pollMs])

  useEffect(() => {
    if (!sseEnabled) return undefined
    const coord = coordinatorRef.current
    const es = new EventSource(syncStreamUrl(['analytics']))
    const onSync = () => coord.schedule()
    const events = [
      'snapshot',
      'analytics.install',
      'analytics.install_reset',
      'analytics.reset',
      'analytics.session_start',
      'analytics.session_heartbeat',
      'analytics.session_end',
      'analytics.presence_expired',
      'analytics.transaction_updated',
      'analytics.subscription_updated',
    ]
    for (const ev of events) es.addEventListener(ev, onSync)
    return () => {
      coord.cancel()
      es.close()
    }
  }, [sseEnabled])
}
