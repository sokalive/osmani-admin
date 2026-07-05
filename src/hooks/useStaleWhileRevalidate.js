import { useCallback, useRef, useState } from 'react'

/**
 * List/detail fetch that keeps last-known-good data visible during background refresh.
 * @param {() => Promise<T>} fetchFn
 * @param {{ onError?: (e: Error) => void }} [opts]
 */
export function useStaleWhileRevalidate(fetchFn, opts = {}) {
  const [data, setData] = useState(null)
  const [initialLoading, setInitialLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const hasDataRef = useRef(false)
  const genRef = useRef(0)

  const reload = useCallback(async () => {
    const gen = ++genRef.current
    const isFirst = !hasDataRef.current
    if (isFirst) setInitialLoading(true)
    else setRefreshing(true)
    try {
      const next = await fetchFn()
      if (gen !== genRef.current) return
      setData(next)
      hasDataRef.current = true
    } catch (e) {
      if (gen !== genRef.current) return
      opts.onError?.(e)
      /* keep existing data on transient failure */
    } finally {
      if (gen === genRef.current) {
        setInitialLoading(false)
        setRefreshing(false)
      }
    }
  }, [fetchFn, opts])

  return { data, setData, initialLoading, refreshing, reload, hasData: hasDataRef.current }
}

/**
 * Rows fetch — preserves prior rows during refresh; never clears on error.
 */
export function useStaleListRows(fetchRows, { onError } = {}) {
  const [rows, setRows] = useState([])
  const [initialLoading, setInitialLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const hasRowsRef = useRef(false)
  const genRef = useRef(0)

  const reload = useCallback(async () => {
    const gen = ++genRef.current
    const isFirst = !hasRowsRef.current
    if (isFirst) setInitialLoading(true)
    else setRefreshing(true)
    try {
      const next = await fetchRows()
      if (gen !== genRef.current) return
      const list = Array.isArray(next) ? next : []
      setRows(list)
      hasRowsRef.current = true
    } catch (e) {
      if (gen !== genRef.current) return
      onError?.(e)
    } finally {
      if (gen === genRef.current) {
        setInitialLoading(false)
        setRefreshing(false)
      }
    }
  }, [fetchRows, onError])

  return { rows, setRows, initialLoading, refreshing, reload, hasRows: hasRowsRef.current }
}
