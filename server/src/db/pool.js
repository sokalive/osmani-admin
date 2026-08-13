import pg from 'pg'
import {
  assertPoolCanAcceptWork,
  connectWithSaturationGuard,
  getPoolSaturationStats,
  isPoolSaturated,
  maxPoolWaiting,
} from '../lib/poolSaturation.js'

const { Pool, Client } = pg

/** Fail-fast is armed only after startup finishes ensuring tables. */
let _poolGuardArmed = false

/**
 * While true, shared pool checkout is refused (except nested withStartupDbBypass).
 * Contabo fix: ensure DDL must not share/compete with request traffic on the pool.
 */
let _startupPoolLocked = false
let _startupBypassDepth = 0

export function armPoolSaturationGuard() {
  _poolGuardArmed = true
}

export function isPoolSaturationGuardArmed() {
  return _poolGuardArmed
}

export function setStartupPoolLocked(locked) {
  _startupPoolLocked = Boolean(locked)
}

export function isStartupPoolLocked() {
  return _startupPoolLocked
}

/** Allow intentional pool use during locked startup (rare). Prefer withDedicatedClient. */
export async function withStartupDbBypass(fn) {
  _startupBypassDepth += 1
  try {
    return await fn()
  } finally {
    _startupBypassDepth -= 1
  }
}

function assertPoolNotStartupLocked(label) {
  if (_startupPoolLocked && _startupBypassDepth <= 0) {
    const err = new Error(`startup_pool_locked:${label || 'pool'}`)
    err.code = 'STARTUP_POOL_LOCKED'
    err.statusCode = 503
    err.retryable = true
    throw err
  }
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
  // Hard ceiling 80 — never approach PG max_connections=100; leave room for LISTEN,
  // dedicated DDL clients, and ad-hoc scripts.
  if (Number.isFinite(n) && n >= 1) return Math.min(80, Math.trunc(n))
  // VPS (Contabo): measured safe default after match-peak proof.
  // Prior: pool 30 failed kickoff at 2000; pool 40 passed 3000 with peak PG ~58/100.
  // Default 50 keeps critical headroom (~12 idle reserved) while absorbing bursts.
  return isVpsProduction() ? 50 : 8
}

function defaultStatementTimeoutMs() {
  return Math.max(1000, Number(process.env.PG_STATEMENT_TIMEOUT_MS) || 8000)
}

function idleInTxnTimeoutMs() {
  return Math.max(1000, Number(process.env.PG_IDLE_IN_TXN_TIMEOUT_MS) || 15_000)
}

function sslForConnectionString(connectionString) {
  const isLocal =
    /localhost|127\.0\.0\.1/i.test(connectionString) ||
    process.env.PGSSLMODE === 'disable'
  return isLocal ? {} : { ssl: { rejectUnauthorized: false } }
}

function poolOptions() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) return null
  const idleMs = Math.max(
    10_000,
    Number(process.env.PG_POOL_IDLE_TIMEOUT_MS) || 30_000,
  )
  const max = poolMaxConnections()
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
    // Do NOT set statement_timeout here — Contabo startup runs large ensure/DDL
    // that can exceed a few seconds. Query helpers set statement_timeout per checkout.
    // Kill abandoned open transactions only.
    options: `-c idle_in_transaction_session_timeout=${Math.trunc(idleInTxnMs)}`,
    ...sslForConnectionString(connectionString),
  }
}

/**
 * Dedicated one-off client outside PG_POOL_MAX — for Contabo ensure/DDL so startup
 * cannot starve or leak shared pool checkouts.
 */
export async function withDedicatedClient(fn, label = 'dedicated') {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is required.')
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: Math.max(
      3000,
      Number(process.env.PG_POOL_CONNECT_TIMEOUT_MS) || 5000,
    ),
    ...sslForConnectionString(connectionString),
  })
  const t0 = Date.now()
  await client.connect()
  try {
    return await fn(client)
  } finally {
    try {
      await client.end()
    } catch (e) {
      console.warn(`[pg] dedicated client end (${label}):`, e?.message || e)
    }
    const ms = Date.now() - t0
    if (ms >= 2000) {
      console.info(`[pg] dedicated client ${label} finished in ${ms}ms`)
    }
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
      startupLocked: _startupPoolLocked,
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
    startupLocked: _startupPoolLocked,
  }
}

function patchPoolFailFast(pool) {
  const origQuery = pool.query.bind(pool)
  const origConnect = pool.connect.bind(pool)
  const rawPool = { connect: () => origConnect() }

  pool.query = (...args) => {
    assertPoolNotStartupLocked('pool.query')
    if (!_poolGuardArmed) return origQuery(...args)
    assertPoolCanAcceptWork(getPoolStats, 'pool.query')
    // Guarded checkout so acquire timeouts apply (bare origQuery waited up to
    // connectionTimeoutMillis and left Contabo waitingCount stacked).
    return connectWithSaturationGuard(rawPool, getPoolStats, 'pool.query').then(async (client) => {
      try {
        return await client.query(...args)
      } finally {
        client.release()
      }
    })
  }

  pool.connect = () => {
    assertPoolNotStartupLocked('pool.connect')
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
        statementTimeoutDefaultMs: defaultStatementTimeoutMs(),
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
      if (s.waitingCount > 0 || s.totalCount >= s.max || s.saturated || s.startupLocked) {
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
