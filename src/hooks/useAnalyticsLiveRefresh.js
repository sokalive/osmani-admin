import { useEffect, useRef } from 'react'
import { syncStreamUrl } from '../lib/api'
import { createRefreshCoordinator } from '../lib/adminRefreshCoordinator'

const ANALYTICS_SSE_DEBOUNCE_MS = 400
/** Ordinary TTL heartbeats — coalesce so Admin does not snapshot-storm under match load. */
const HEARTBEAT_MIN_INTERVAL_MS = 10_000
/** Billing / install / session start-end / expiry. */
const MEANINGFUL_MIN_INTERVAL_MS = 2_000
/** Channel open/leave/switch and online transitions — keep burst coalescing, aim ~0.5–1s. */
const PRESENCE_CHANGED_MIN_INTERVAL_MS = 600

const HEARTBEAT_EVENTS = new Set(['analytics.session_heartbeat'])
const PRESENCE_CHANGED_EVENTS = new Set(['analytics.presence_changed'])

const MEANINGFUL_EVENTS = [
  'snapshot',
  'analytics.install',
  'analytics.install_reset',
  'analytics.reset',
  'analytics.session_start',
  'analytics.session_end',
  'analytics.presence_expired',
  'analytics.transaction_updated',
  'analytics.subscription_updated',
]

/**
 * SSE-driven analytics refresh with optional long-interval safety poll.
 * Dedupes overlapping poll/SSE-triggered loads.
 * Ordinary heartbeats are throttled; presence_changed refreshes quickly via coordinator.
 * @param {() => void | Promise<void>} load
 * @param {{ pollMs?: number, sse?: boolean }} [opts]
 */
export function useAnalyticsLiveRefresh(load, opts = {}) {
  const pollMs = Math.max(60_000, Number(opts.pollMs) || 120_000)
  const sseEnabled = opts.sse !== false
  const loadRef = useRef(load)
  loadRef.current = load
  const coordinatorRef = useRef(null)
  if (!coordinatorRef.current) {
    coordinatorRef.current = createRefreshCoordinator(() => loadRef.current(), {
      debounceMs: ANALYTICS_SSE_DEBOUNCE_MS,
      minIntervalMs: HEARTBEAT_MIN_INTERVAL_MS,
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
    const onHeartbeat = () => coord.schedule({ minIntervalMs: HEARTBEAT_MIN_INTERVAL_MS })
    const onPresenceChanged = () =>
      coord.schedule({ minIntervalMs: PRESENCE_CHANGED_MIN_INTERVAL_MS })
    const onMeaningful = () => coord.schedule({ minIntervalMs: MEANINGFUL_MIN_INTERVAL_MS })
    for (const ev of HEARTBEAT_EVENTS) es.addEventListener(ev, onHeartbeat)
    for (const ev of PRESENCE_CHANGED_EVENTS) es.addEventListener(ev, onPresenceChanged)
    for (const ev of MEANINGFUL_EVENTS) es.addEventListener(ev, onMeaningful)
    return () => {
      coord.cancel()
      es.close()
    }
  }, [sseEnabled])
}
