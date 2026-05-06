import { Router } from 'express'
import { getPool } from '../db/pool.js'

export const analyticsRouter = Router()

const OVERVIEW_ZERO = {
  onlineNow: 0,
  newUsersToday: 0,
  revenueToday: 0,
  totalInstalls: 0,
}

function numOrZero(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

async function safeQueryScalar(pool, sql, label, mapRow) {
  try {
    const { rows } = await pool.query(sql)
    return mapRow(rows[0])
  } catch (e) {
    console.error(`[analytics] ${label}:`, e)
    return null
  }
}

async function resolveLiveSessionsTimeExpr(pool) {
  try {
    const { rows } = await pool.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'live_sessions'`,
    )
    const cols = new Set(rows.map((r) => String(r.column_name)))
    if (cols.has('updated_at')) return 'updated_at'
    if (cols.has('created_at')) return 'created_at'
    if (cols.has('started_at')) return 'started_at'
    return null
  } catch (e) {
    console.error('[analytics] resolveLiveSessionsTimeExpr:', e)
    return null
  }
}

analyticsRouter.get('/overview', async (_req, res) => {
  try {
    const pool = getPool()
    if (!pool) {
      console.error('[analytics/overview] DATABASE_URL not set — no database pool')
      return res.status(200).json({
        ...OVERVIEW_ZERO,
        degraded: true,
        error: 'Database not configured',
      })
    }

    const onlineNowRaw = await safeQueryScalar(
      pool,
      `SELECT COUNT(*)::int AS c FROM live_sessions`,
      'overview.onlineNow',
      (r) => numOrZero(r?.c),
    )
    const newUsersTodayRaw = await safeQueryScalar(
      pool,
      `SELECT COUNT(*)::int AS c
       FROM device_subscriptions
       WHERE started_at >= date_trunc('day', now())`,
      'overview.newUsersToday',
      (r) => numOrZero(r?.c),
    )
    const revenueTodayRaw = await safeQueryScalar(
      pool,
      `SELECT COALESCE(SUM(amount), 0)::numeric AS s
       FROM transactions
       WHERE lower(status) = 'completed'
         AND created_at >= date_trunc('day', now())`,
      'overview.revenueToday',
      (r) => numOrZero(r?.s),
    )
    const totalInstallsRaw = await safeQueryScalar(
      pool,
      `SELECT COUNT(*)::int AS c FROM app_installs`,
      'overview.totalInstalls',
      (r) => numOrZero(r?.c),
    )

    const degraded =
      onlineNowRaw === null ||
      newUsersTodayRaw === null ||
      revenueTodayRaw === null ||
      totalInstallsRaw === null

    res.json({
      onlineNow: onlineNowRaw ?? 0,
      newUsersToday: newUsersTodayRaw ?? 0,
      revenueToday: revenueTodayRaw ?? 0,
      totalInstalls: totalInstallsRaw ?? 0,
      ...(degraded ? { degraded: true } : {}),
    })
  } catch (e) {
    console.error('[analytics/overview] fatal:', e)
    res.status(200).json({
      ...OVERVIEW_ZERO,
      degraded: true,
      error: String(e.message || e),
    })
  }
})

analyticsRouter.get('/channels', async (_req, res) => {
  try {
    const pool = getPool()
    if (!pool) {
      console.error('[analytics/channels] DATABASE_URL not set — no database pool')
      return res.status(200).json({
        mostWatched: [],
        top5: [],
        degraded: true,
        error: 'Database not configured',
      })
    }
    const { rows } = await pool.query(
      `SELECT channel_id, COUNT(*)::int AS viewers
       FROM live_sessions
       WHERE channel_id IS NOT NULL
       GROUP BY channel_id
       ORDER BY viewers DESC`,
    )
    const mapped = rows.map((r) => ({
      channel_id: String(r.channel_id),
      viewers: Number(r.viewers) || 0,
    }))
    res.json({
      mostWatched: mapped,
      top5: mapped.slice(0, 5),
    })
  } catch (e) {
    console.error('[analytics/channels]', e)
    res.status(200).json({
      mostWatched: [],
      top5: [],
      degraded: true,
      error: String(e.message || e),
    })
  }
})

analyticsRouter.get('/locations', async (_req, res) => {
  try {
    const pool = getPool()
    if (!pool) {
      console.error('[analytics/locations] DATABASE_URL not set — no database pool')
      return res.status(200).json([])
    }
    const { rows } = await pool.query(
      `SELECT country, COUNT(*)::int AS users
       FROM live_sessions
       WHERE country IS NOT NULL AND trim(country) <> ''
       GROUP BY country
       ORDER BY users DESC`,
    )
    res.json(
      rows.map((r) => ({
        country: String(r.country),
        users: Number(r.users) || 0,
      })),
    )
  } catch (e) {
    console.error('[analytics/locations]', e)
    res.status(200).json([])
  }
})

analyticsRouter.get('/trend', async (_req, res) => {
  try {
    const pool = getPool()
    if (!pool) {
      console.error('[analytics/trend] DATABASE_URL not set — no database pool')
      return res.status(200).json([])
    }
    const tsCol = await resolveLiveSessionsTimeExpr(pool)
    if (!tsCol) {
      return res.status(200).json([])
    }
    const { rows } = await pool.query(
      `SELECT
         (
           date_trunc('hour', ${tsCol})
           + floor(date_part('minute', ${tsCol}) / 5) * interval '5 minutes'
         )::timestamptz AS time,
         COUNT(*)::int AS users
       FROM live_sessions
       WHERE ${tsCol} IS NOT NULL
       GROUP BY 1
       ORDER BY 1 ASC`,
    )
    res.json(
      rows.map((r) => ({
        time: r.time instanceof Date ? r.time.toISOString() : String(r.time),
        users: Number(r.users) || 0,
      })),
    )
  } catch (e) {
    console.error('[analytics/trend]', e)
    res.status(200).json([])
  }
})
