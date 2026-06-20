import { useEffect, useRef } from 'react'
import { syncStreamUrl } from '../lib/api'

const ANALYTICS_SSE_DEBOUNCE_MS = 350

/**
 * Poll analytics + debounced SSE refresh (avoids thundering herd on presence_expired).
 * @param {() => void | Promise<void>} load
 * @param {{ pollMs?: number, sse?: boolean }} [opts]
 */
export function useAnalyticsLiveRefresh(load, opts = {}) {
  const pollMs = Math.max(5000, Number(opts.pollMs) || 15_000)
  const sseEnabled = opts.sse !== false
  const debounceRef = useRef(null)

  useEffect(() => {
    void load()
    const pollId = window.setInterval(() => void load(), pollMs)
    return () => window.clearInterval(pollId)
  }, [load, pollMs])

  useEffect(() => {
    if (!sseEnabled) return undefined
    const es = new EventSource(syncStreamUrl(['analytics']))
    const onSync = () => {
      window.clearTimeout(debounceRef.current)
      debounceRef.current = window.setTimeout(() => void load(), ANALYTICS_SSE_DEBOUNCE_MS)
    }
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
      window.clearTimeout(debounceRef.current)
      es.close()
    }
  }, [load, sseEnabled])
}
