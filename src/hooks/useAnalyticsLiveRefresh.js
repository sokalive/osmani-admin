import { useEffect, useRef } from 'react'
import { syncStreamUrl } from '../lib/api'

const ANALYTICS_POLL_MS = 10_000
const ANALYTICS_SSE_DEBOUNCE_MS = 600

/**
 * Poll analytics + debounced SSE refresh (avoids thundering herd on presence_expired).
 */
export function useAnalyticsLiveRefresh(load) {
  const debounceRef = useRef(null)

  useEffect(() => {
    void load()
    const pollId = window.setInterval(() => void load(), ANALYTICS_POLL_MS)
    return () => window.clearInterval(pollId)
  }, [load])

  useEffect(() => {
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
  }, [load])
}
