/**
 * In-flight fetch deduplication + SSE/poll coalescing for Admin pages.
 * schedule() accepts an optional per-call minIntervalMs so high-frequency SSE
 * (e.g. presence heartbeats) can be throttled harder than meaningful events.
 */
export function createRefreshCoordinator(loadFn, { debounceMs = 400, minIntervalMs = 800 } = {}) {
  let inFlight = null
  let debounceTimer = null
  let lastRunAt = 0
  let gen = 0
  let pendingMinIntervalMs = minIntervalMs

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

  /**
   * @param {{ minIntervalMs?: number }} [opts]
   */
  const schedule = (opts = {}) => {
    const override = Number(opts?.minIntervalMs)
    const nextMin =
      Number.isFinite(override) && override > 0 ? override : minIntervalMs
    // If multiple events coalesce, keep the *shortest* requested wait so
    // meaningful changes are not delayed behind heartbeat throttling.
    pendingMinIntervalMs = Math.min(pendingMinIntervalMs, nextMin)

    globalThis.clearTimeout(debounceTimer)
    debounceTimer = globalThis.setTimeout(() => {
      debounceTimer = null
      const minI = pendingMinIntervalMs
      pendingMinIntervalMs = minIntervalMs
      const since = Date.now() - lastRunAt
      if (since < minI) {
        debounceTimer = globalThis.setTimeout(() => {
          debounceTimer = null
          void runNow()
        }, minI - since)
        return
      }
      void runNow()
    }, debounceMs)
  }

  const cancel = () => {
    globalThis.clearTimeout(debounceTimer)
    debounceTimer = null
    pendingMinIntervalMs = minIntervalMs
  }

  return { runNow, schedule, cancel, isInFlight: () => !!inFlight }
}
