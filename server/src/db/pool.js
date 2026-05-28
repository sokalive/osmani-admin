import pg from 'pg'

const { Pool } = pg

if (!process.env.DATABASE_URL) {
  console.warn('⚠️  DATABASE_URL is not set — channel routes will fail until PostgreSQL is configured.')
}

function poolMaxConnections() {
  const n = Number(process.env.PG_POOL_MAX)
  if (Number.isFinite(n) && n >= 1) return Math.min(20, Math.trunc(n))
  // Single Render Starter instance: avoid hoarding connections on managed Postgres.
  return 8
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
  return {
    connectionString,
    max: poolMaxConnections(),
    idleTimeoutMillis: idleMs,
    connectionTimeoutMillis: Math.max(
      2000,
      Number(process.env.PG_POOL_CONNECT_TIMEOUT_MS) || 10_000,
    ),
    ...(isLocal ? {} : { ssl: { rejectUnauthorized: false } }),
  }
}

/** @type {import('pg').Pool | null} */
let _pool = null

export function getPool() {
  if (!_pool) {
    const opts = poolOptions()
    if (!opts) return null
    _pool = new Pool(opts)
    if (String(process.env.PG_POOL_LOG || '').trim() === '1') {
      console.info(
        '[pg] pool ready:',
        JSON.stringify({ max: opts.max, idleTimeoutMillis: opts.idleTimeoutMillis }),
      )
    }
  }
  return _pool
}

export async function closePool() {
  if (_pool) {
    await _pool.end()
    _pool = null
  }
}
