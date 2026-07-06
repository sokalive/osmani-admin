/** Flush SSE through nginx / compression layers when supported. */
export function flushSseResponse(res) {
  try {
    if (typeof res.flush === 'function') res.flush()
    else if (typeof res.flushHeaders === 'function' && !res.headersSent) res.flushHeaders()
  } catch {
    /* ignore */
  }
}
