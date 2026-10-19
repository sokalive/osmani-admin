/** Flush SSE through nginx / compression layers when supported. */
export function flushSseResponse(res) {
  try {
    if (typeof res.flushHeaders === 'function' && !res.headersSent) res.flushHeaders()
    if (typeof res.flush === 'function') res.flush()
    const socket = res?.socket
    if (socket && typeof socket.uncork === 'function') socket.uncork()
  } catch {
    /* ignore */
  }
}

export function writeSseEvent(res, event, data) {
  const body = typeof data === 'string' ? data : JSON.stringify(data)
  res.write(`event: ${event}\n`)
  res.write(`data: ${body}\n\n`)
  flushSseResponse(res)
}

export function writeSseComment(res, comment = 'ping') {
  res.write(`: ${comment}\n\n`)
  flushSseResponse(res)
}
