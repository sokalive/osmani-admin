import { useEffect, useRef } from 'react'
import { syncStreamUrl } from '../lib/api'
import { createRefreshCoordinator } from '../lib/adminRefreshCoordinator'

/**
 * Debounced SSE + optional slow poll for Admin config/analytics pages.
 * Prefer realtime; poll is only a safety net when SSE is quiet.
 *
 * @param {() => void | Promise<void>} load
 * @param {{
 *   topics?: string[],
 *   events?: string[],
 *   pollMs?: number,
 *   sse?: boolean,
 *   debounceMs?: number,
 *   minIntervalMs?: number,
 * }} [opts]
 */
export function useAdminLiveRefresh(load, opts = {}) {
  const topics = opts.topics?.length ? opts.topics : ['config']
  const events = opts.events?.length
    ? opts.events
    : [
        'snapshot',
        'config.settings_changed',
        'config.channels_changed',
        'config.plans_changed',
        'config.notifications_changed',
        'channels_changed',
        'channels_catalog',
        'subscription_request_updated',
        'analytics.transaction_updated',
        'analytics.subscription_updated',
      ]
  // Slow fallback — realtime is primary. Min 20s to avoid hammering.
  const pollMs = Math.max(20_000, Number(opts.pollMs) || 60_000)
  const sseEnabled = opts.sse !== false
  const debounceMs = Number(opts.debounceMs) || 350
  const minIntervalMs = Number(opts.minIntervalMs) || 900

  const loadRef = useRef(load)
  loadRef.current = load
  const coordinatorRef = useRef(null)
  if (!coordinatorRef.current) {
    coordinatorRef.current = createRefreshCoordinator(() => loadRef.current(), {
      debounceMs,
      minIntervalMs,
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
    const es = new EventSource(syncStreamUrl(topics))
    const onSync = () => coord.schedule()
    for (const ev of events) es.addEventListener(ev, onSync)
    return () => {
      coord.cancel()
      es.close()
    }
  }, [sseEnabled, topics.join(','), events.join(',')])
}
