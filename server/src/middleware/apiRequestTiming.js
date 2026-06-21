/**
 * Log slow API requests (admin + mobile diagnostics).
 */
import { getPoolStats } from '../db/pool.js'

const SLOW_MS = Math.max(200, Number(process.env.API_SLOW_REQUEST_MS) || 1500)

const HOT_PATH_RE =
  /^\/api\/(update-check|subscription-status|subscription\/verify|subscription\/recover|runtime\/app-update|payments\/)/

export function apiRequestTimingMiddleware(req, res, next) {
  const start = process.hrtime.bigint()
  const path = String(req.originalUrl || req.url || '').split('?')[0]

  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6
    if (ms < SLOW_MS && !HOT_PATH_RE.test(path)) return
    const payload = {
      method: req.method,
      path,
      status: res.statusCode,
      ms: Math.round(ms),
    }
    if (ms >= SLOW_MS || HOT_PATH_RE.test(path)) {
      payload.pool = getPoolStats()
    }
    if (ms >= SLOW_MS) {
      console.warn('[api-slow]', payload)
    } else if (HOT_PATH_RE.test(path) && ms >= 400) {
      console.info('[api-hot]', payload)
    }
  })

  next()
}
