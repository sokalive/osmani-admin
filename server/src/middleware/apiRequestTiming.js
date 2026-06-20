/**
 * Log slow API requests (admin + mobile diagnostics).
 */
const SLOW_MS = Math.max(200, Number(process.env.API_SLOW_REQUEST_MS) || 1500)

export function apiRequestTimingMiddleware(req, res, next) {
  const start = process.hrtime.bigint()
  const path = String(req.originalUrl || req.url || '').split('?')[0]

  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6
    if (ms < SLOW_MS) return
    console.warn('[api-slow]', {
      method: req.method,
      path,
      status: res.statusCode,
      ms: Math.round(ms),
    })
  })

  next()
}
