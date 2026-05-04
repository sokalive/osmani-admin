import pg from 'pg'

const { Pool } = pg

if (!process.env.DATABASE_URL) {
  console.warn('⚠️  DATABASE_URL is not set — channel routes will fail until PostgreSQL is configured.')
}

function poolOptions() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) return null
  const isLocal =
    /localhost|127\.0\.0\.1/i.test(connectionString) ||
    process.env.PGSSLMODE === 'disable'
  return {
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
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
  }
  return _pool
}

export async function closePool() {
  if (_pool) {
    await _pool.end()
    _pool = null
  }
}
