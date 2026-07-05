import { useCallback, useRef, useState } from 'react'
import { shouldReplaceRows } from '../lib/adminDataGuards'
import { readAdminSnapshot, writeAdminSnapshot } from '../lib/adminSnapshotCache'

/**
 * List fetch with sessionStorage hydration, error retention, and empty guards.
 * @param {string} pageKey
 * @param {() => Promise<unknown>} fetchRows
 * @param {{ mapRows?: (data: unknown) => unknown[], onError?: (e: Error) => void, snapshotField?: string }} [opts]
 */
export function useAdminStaleList(pageKey, fetchRows, opts = {}) {
  const snapshotField = opts.snapshotField || 'rows'
  const cached = readAdminSnapshot(pageKey)
  const initial = Array.isArray(cached?.[snapshotField]) ? cached[snapshotField] : []
  const [rows, setRows] = useState(initial)
  const rowsRef = useRef(initial)
  rowsRef.current = rows
  const hasRowsRef = useRef(initial.length > 0)
  const genRef = useRef(0)
  const [initialLoading, setInitialLoading] = useState(!hasRowsRef.current)
  const [refreshing, setRefreshing] = useState(false)

  const mapRows = opts.mapRows || ((d) => (Array.isArray(d) ? d : []))

  const reload = useCallback(async () => {
    const gen = ++genRef.current
    const isFirst = !hasRowsRef.current
    if (isFirst) setInitialLoading(true)
    else setRefreshing(true)
    try {
      const data = await fetchRows()
      if (gen !== genRef.current) return
      const list = mapRows(data)
      if (!shouldReplaceRows(rowsRef.current, list)) return
      setRows(list)
      rowsRef.current = list
      if (list.length > 0) hasRowsRef.current = true
      writeAdminSnapshot(pageKey, { [snapshotField]: list })
    } catch (e) {
      if (gen !== genRef.current) return
      opts.onError?.(e)
    } finally {
      if (gen === genRef.current) {
        setInitialLoading(false)
        setRefreshing(false)
      }
    }
  }, [pageKey, fetchRows, mapRows, opts, snapshotField])

  return { rows, setRows, reload, initialLoading, refreshing, hasRows: hasRowsRef.current }
}
