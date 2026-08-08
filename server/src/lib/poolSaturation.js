/**
 * Pool saturation guards: fail-fast before unbounded waitingCount growth.
 * Pure helpers stay free of circular imports with db/pool.js.
 */
export class PoolSaturatedError extends Error {
  constructor(message = 'pool_saturated', extra = {}) {
    super(message)
    this.name = 'PoolSaturatedError'
    this.code = 'POOL_SATURATED'
    this.statusCode = 503
    this.retryable = true
    Object.assign(this, extra)
  }
}

function envPoolMaxFallback() {
  const n = Number(process.env.PG_POOL_MAX)
  if (Number.isFinite(n) && n >= 1) return Math.min(30, Math.trunc(n))
  const vps =
    String(process.env.OSMANI_VPS || '').trim() === '1' ||
    /api\.osmanitv\.com/i.test(String(process.env.BASE_URL || '')) ||
    /144\.91\.117\.90/.test(String(process.env.BASE_URL || ''))
  return vps ? 30 : 8
}

export function maxPoolWaiting(poolMax = envPoolMaxFallback()) {
  const configured = Number(process.env.PG_POOL_MAX_WAITING)
  if (Number.isFinite(configured) && configured >= 1) {
    return Math.min(500, Math.trunc(configured))
  }
  return Math.max(10, Number(poolMax) * 2)
}

export function poolAcquireTimeoutMs() {
  return Math.max(200, Math.min(15_000, Number(process.env.PG_POOL_ACQUIRE_TIMEOUT_MS) || 2500))
}

export function isPoolSaturated(stats = {}) {
  const max = Number(stats.max) || envPoolMaxFallback()
  const waiting = Number(stats.waitingCount) || 0
  const idle = Number(stats.idleCount) || 0
  const total = Number(stats.totalCount) || 0
  if (waiting >= maxPoolWaiting(max)) return true
  if (max > 0 && total >= max && idle === 0 && waiting >= Math.max(5, Math.floor(max / 2))) {
    return true
  }
  return false
}

export function assertPoolCanAcceptWork(getStats, label = 'query') {
  const stats = typeof getStats === 'function' ? getStats() : getStats
  if (!isPoolSaturated(stats)) return stats
  throw new PoolSaturatedError('pool_saturated', {
    label: String(label || 'query'),
    pool: stats,
    maxWaiting: maxPoolWaiting(stats?.max),
  })
}

export function isPoolSaturationError(err) {
  if (!err) return false
  if (err instanceof PoolSaturatedError || err?.code === 'POOL_SATURATED') return true
  const msg = String(err?.message || err || '').toLowerCase()
  return (
    msg.includes('pool_saturated') ||
    msg.includes('pool_acquire_timeout') ||
    msg.includes('timeout exceeded when trying to connect')
  )
}

/**
 * Acquire a client with fail-fast saturation check + acquire timeout.
 * On timeout, the late connect (if any) is released to avoid leaks.
 */
export async function connectWithSaturationGuard(pool, getStats, label = 'connect') {
  if (!pool) throw new Error('DATABASE_URL is required.')
  assertPoolCanAcceptWork(getStats, label)
  const timeoutMs = poolAcquireTimeoutMs()
  let timedOut = false
  let timer = null
  try {
    const client = await Promise.race([
      pool.connect().then((c) => {
        if (timedOut) {
          try {
            c.release()
          } catch {
            /* ignore */
          }
          return null
        }
        return c
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          reject(
            new PoolSaturatedError('pool_acquire_timeout', {
              label: String(label || 'connect'),
              timeoutMs,
              pool: typeof getStats === 'function' ? getStats() : getStats,
            }),
          )
        }, timeoutMs)
      }),
    ])
    if (!client) {
      throw new PoolSaturatedError('pool_acquire_timeout', {
        label: String(label || 'connect'),
        timeoutMs,
        pool: typeof getStats === 'function' ? getStats() : getStats,
      })
    }
    return client
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function getPoolSaturationStats(getStats) {
  const pool = typeof getStats === 'function' ? getStats() : getStats
  return {
    saturated: isPoolSaturated(pool),
    maxWaiting: maxPoolWaiting(pool?.max),
    acquireTimeoutMs: poolAcquireTimeoutMs(),
    pool,
  }
}
