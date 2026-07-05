/**
 * In-flight fetch deduplication + SSE/poll coalescing for Admin pages.
 */
export function createRefreshCoordinator(loadFn, { debounceMs = 400, minIntervalMs = 800 } = {}) {
  let inFlight = null
  let debounceTimer = null
  let lastRunAt = 0
  let gen = 0

  const runNow = async () => {
    if (inFlight) return inFlight
    const myGen = ++gen
    lastRunAt = Date.now()
    inFlight = Promise.resolve()
      .then(() => loadFn())
      .finally(() => {
        if (gen === myGen) inFlight = null
      })
    return inFlight
  }

  const schedule = () => {
    window.clearTimeout(debounceTimer)
    debounceTimer = window.setTimeout(() => {
      debounceTimer = null
      const since = Date.now() - lastRunAt
      if (since < minIntervalMs) {
        debounceTimer = window.setTimeout(() => {
          debounceTimer = null
          void runNow()
        }, minIntervalMs - since)
        return
      }
      void runNow()
    }, debounceMs)
  }

  const cancel = () => {
    window.clearTimeout(debounceTimer)
    debounceTimer = null
  }

  return { runNow, schedule, cancel, isInFlight: () => !!inFlight }
}
