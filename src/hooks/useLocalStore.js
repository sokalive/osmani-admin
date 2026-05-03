import { useCallback, useEffect, useState } from 'react'

function load(key, getDefault) {
  try {
    const raw = localStorage.getItem(key)
    if (raw) return JSON.parse(raw)
  } catch {
    /* ignore */
  }
  const d = getDefault
  return typeof d === 'function' ? d() : d
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* ignore quota */
  }
}

/**
 * Synced React state with localStorage — survives refresh.
 */
export function useLocalStore(key, getDefault) {
  const [state, setState] = useState(() => load(key, getDefault))

  useEffect(() => {
    save(key, state)
  }, [key, state])

  const update = useCallback((patchOrFn) => {
    setState((prev) => {
      const next = typeof patchOrFn === 'function' ? patchOrFn(prev) : patchOrFn
      return next
    })
  }, [])

  return [state, setState, update]
}
