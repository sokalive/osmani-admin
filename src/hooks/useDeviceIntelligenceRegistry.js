import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useToast } from '../context/ToastContext.jsx'
import {
  getUsersIntelligenceList,
  postUsersIntelligenceBackfill,
  postUsersIntelligenceSyncBlocks,
} from '../lib/api'
import { shouldReplaceRows } from '../lib/adminDataGuards'
import { readAdminSnapshot, writeAdminSnapshot } from '../lib/adminSnapshotCache'
import {
  USERS_INTELLIGENCE_CACHE_KEY,
  writeDeviceIntelligenceSummaryCache,
} from '../lib/deviceIntelligenceSummary'
import { createRefreshCoordinator } from '../lib/adminRefreshCoordinator'

/** Session-scoped: avoid re-running backfill on every registry page mount. */
let registryWarmupStarted = false

function ensureRegistryWarmup() {
  if (registryWarmupStarted) return
  registryWarmupStarted = true
  void Promise.all([
    postUsersIntelligenceBackfill().catch(() => {}),
    postUsersIntelligenceSyncBlocks().catch(() => {}),
  ])
}

/**
 * Shared Users Intelligence / Device Registry data layer.
 * One list+summary query path; optional live poll keeps totals in sync with Dashboard.
 *
 * @param {{ pollMs?: number, statusFilter?: string }} [opts]
 */
export function useDeviceIntelligenceRegistry(opts = {}) {
  const pollMs = Math.max(0, Number(opts.pollMs) || 0)
  const statusFilter = String(opts.statusFilter || 'all').toLowerCase()
  const { showToast } = useToast()

  const cached = readAdminSnapshot(USERS_INTELLIGENCE_CACHE_KEY)
  const initialItems = Array.isArray(cached?.items) ? cached.items : []
  const [loading, setLoading] = useState(initialItems.length === 0)
  const [items, setItems] = useState(initialItems)
  const itemsRef = useRef(initialItems)
  itemsRef.current = items
  const loadGenRef = useRef(0)
  const [summary, setSummary] = useState(cached?.summary ?? null)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const queryRef = useRef('')
  queryRef.current = query

  const load = useCallback(
    async (q) => {
      const gen = ++loadGenRef.current
      const term = typeof q === 'string' ? q : queryRef.current
      const isFirst = itemsRef.current.length === 0 && !term
      if (isFirst) setLoading(true)
      try {
        const data = await getUsersIntelligenceList(term)
        if (gen !== loadGenRef.current) return
        const nextItems = data.items || []
        if (shouldReplaceRows(itemsRef.current, nextItems)) setItems(nextItems)
        if (data.summary) {
          setSummary(data.summary)
          writeDeviceIntelligenceSummaryCache(data.summary)
        }
        if (!term) {
          writeAdminSnapshot(USERS_INTELLIGENCE_CACHE_KEY, {
            items: nextItems,
            summary: data.summary ?? null,
          })
        }
      } catch (e) {
        if (gen !== loadGenRef.current) return
        showToast('error', String(e.message || e))
      } finally {
        if (gen === loadGenRef.current) setLoading(false)
      }
    },
    [showToast],
  )

  useEffect(() => {
    void load('')
    ensureRegistryWarmup()
  }, [load])

  useEffect(() => {
    if (!pollMs) return undefined
    const coord = createRefreshCoordinator(() => load(queryRef.current), {
      debounceMs: 350,
      minIntervalMs: 900,
    })
    const pollId = window.setInterval(() => void coord.runNow(), pollMs)
    return () => {
      coord.cancel()
      window.clearInterval(pollId)
    }
  }, [load, pollMs])

  const handleSearch = useCallback(
    (e) => {
      e.preventDefault()
      const next = search.trim()
      setQuery(next)
      void load(next)
    },
    [load, search],
  )

  const clearSearch = useCallback(() => {
    setSearch('')
    setQuery('')
    void load('')
  }, [load])

  const filteredItems = useMemo(() => {
    if (statusFilter === 'all' || !statusFilter) return items
    return items.filter((row) => String(row.status || '').toLowerCase() === statusFilter)
  }, [items, statusFilter])

  return {
    loading,
    items: filteredItems,
    allItems: items,
    summary,
    search,
    setSearch,
    query,
    handleSearch,
    clearSearch,
    reload: load,
  }
}
