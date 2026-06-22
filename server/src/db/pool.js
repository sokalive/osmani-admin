import pg from 'pg'

const { Pool } = pg

if (!process.env.DATABASE_URL) {
  console.warn('⚠️  DATABASE_URL is not set — channel routes will fail until PostgreSQL is configured.')
}

export function isVpsProduction() {
  return (
    String(process.env.OSMANI_VPS || '').trim() === '1' ||
    /api\.osmanitv\.com/i.test(String(process.env.BASE_URL || '')) ||
    /144\.91\.117\.90/.test(String(process.env.BASE_URL || ''))
  )
}

export function poolMaxConnections() {
  const n = Number(process.env.PG_POOL_MAX)
  if (Number.isFinite(n) && n >= 1) return Math.min(30, Math.trunc(n))
  // VPS (Contabo): more headroom; Render starter stays conservative.
  return isVpsProduction() ? 30 : 8
}

function poolOptions() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) return null
  const isLocal =
    /localhost|127\.0\.0\.1/i.test(connectionString) ||
    process.env.PGSSLMODE === 'disable'
  const idleMs = Math.max(
    10_000,
    Number(process.env.PG_POOL_IDLE_TIMEOUT_MS) || 30_000,
  )
  const max = poolMaxConnections()
  return {
    connectionString,
    max,
    idleTimeoutMillis: idleMs,
    connectionTimeoutMillis: Math.max(
      1000,
      Number(process.env.PG_POOL_CONNECT_TIMEOUT_MS) || 5000,
    ),
    allowExitOnIdle: false,
    ...(isLocal ? {} : { ssl: { rejectUnauthorized: false } }),
  }
}

/** @type {import('pg').Pool | null} */
let _pool = null
let _poolOpts = null

export function getPoolStats() {
  if (!_pool) {
    return { totalCount: 0, idleCount: 0, waitingCount: 0, max: 0 }
  }
  return {
    totalCount: _pool.totalCount,
    idleCount: _pool.idleCount,
    waitingCount: _pool.waitingCount,
    max: _poolOpts?.max ?? poolMaxConnections(),
  }
}

export function getPool() {
  if (!_pool) {
    const opts = poolOptions()
    if (!opts) return null
    _poolOpts = opts
    _pool = new Pool(opts)
    _pool.on('error', (err) => {
      console.error('[pg] idle client error:', err?.message || err)
    })
    console.info(
      '[pg] pool ready:',
      JSON.stringify({
        max: opts.max,
        idleTimeoutMillis: opts.idleTimeoutMillis,
        connectionTimeoutMillis: opts.connectionTimeoutMillis,
        vps: isVpsProduction(),
      }),
    )
    if (String(process.env.PG_POOL_STATS || '').trim() === '1') {
      setInterval(() => {
        const s = getPoolStats()
        if (s.waitingCount > 0 || s.totalCount >= s.max) {
          console.warn('[pg-pool-stats]', s)
        }
      }, 30_000).unref()
    }
  }
  return _pool
}

export async function closePool() {
  if (_pool) {
    await _pool.end()
    _pool = null
    _poolOpts = null
  }
}
