import pg from 'pg'
import {
  assertPoolCanAcceptWork,
  connectWithSaturationGuard,
  getPoolSaturationStats,
  isPoolSaturated,
  maxPoolWaiting,
} from '../lib/poolSaturation.js'

const { Pool } = pg

/** Fail-fast is armed only after startup finishes ensuring tables. */
let _poolGuardArmed = false

export function armPoolSaturationGuard() {
  _poolGuardArmed = true
}

export function isPoolSaturationGuardArmed() {
  return _poolGuardArmed
}

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

function defaultStatementTimeoutMs() {
  return Math.max(1000, Number(process.env.PG_STATEMENT_TIMEOUT_MS) || 8000)
}

function idleInTxnTimeoutMs() {
  return Math.max(1000, Number(process.env.PG_IDLE_IN_TXN_TIMEOUT_MS) || 15_000)
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
  const statementTimeoutMs = defaultStatementTimeoutMs()
  const idleInTxnMs = idleInTxnTimeoutMs()
  return {
    connectionString,
    max,
    idleTimeoutMillis: idleMs,
    // New TCP connect to Postgres only (not pool-queue wait). Keep short.
    connectionTimeoutMillis: Math.max(
      1000,
      Number(process.env.PG_POOL_CONNECT_TIMEOUT_MS) || 5000,
    ),
    allowExitOnIdle: false,
    // Bound query + abandon leaked open transactions at the server side.
    options: `-c statement_timeout=${Math.trunc(statementTimeoutMs)} -c idle_in_transaction_session_timeout=${Math.trunc(idleInTxnMs)}`,
    ...(isLocal ? {} : { ssl: { rejectUnauthorized: false } }),
  }
}

/** @type {import('pg').Pool | null} */
let _pool = null
let _poolOpts = null

export function getPoolStats() {
  if (!_pool) {
    return {
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
      max: 0,
      saturated: false,
      maxWaiting: maxPoolWaiting(poolMaxConnections()),
    }
  }
  const basic = {
    totalCount: _pool.totalCount,
    idleCount: _pool.idleCount,
    waitingCount: _pool.waitingCount,
    max: _poolOpts?.max ?? poolMaxConnections(),
  }
  return {
    ...basic,
    saturated: isPoolSaturated(basic),
    maxWaiting: maxPoolWaiting(basic.max),
  }
}

function patchPoolFailFast(pool) {
  const origQuery = pool.query.bind(pool)
  const origConnect = pool.connect.bind(pool)

  pool.query = (...args) => {
    if (_poolGuardArmed) assertPoolCanAcceptWork(getPoolStats, 'pool.query')
    return origQuery(...args)
  }

  // Adapter so connectWithSaturationGuard can call .connect() without recursing into the patch.
  const rawPool = { connect: () => origConnect() }
  pool.connect = () => {
    if (!_poolGuardArmed) return origConnect()
    return connectWithSaturationGuard(rawPool, getPoolStats, 'pool.connect')
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
    patchPoolFailFast(_pool)
    console.info(
      '[pg] pool ready:',
      JSON.stringify({
        max: opts.max,
        idleTimeoutMillis: opts.idleTimeoutMillis,
        connectionTimeoutMillis: opts.connectionTimeoutMillis,
        statement_timeout: defaultStatementTimeoutMs(),
        idle_in_transaction_session_timeout: idleInTxnTimeoutMs(),
        maxWaiting: maxPoolWaiting(opts.max),
        vps: isVpsProduction(),
      }),
    )
    const statsIntervalMs = Math.max(
      5_000,
      Number(process.env.PG_POOL_STATS_INTERVAL_MS) || 15_000,
    )
    setInterval(() => {
      const s = getPoolStats()
      if (s.waitingCount > 0 || s.totalCount >= s.max || s.saturated) {
        console.warn('[pg-pool-stats]', {
          ...s,
          saturation: getPoolSaturationStats(getPoolStats),
        })
      }
    }, statsIntervalMs).unref()
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
