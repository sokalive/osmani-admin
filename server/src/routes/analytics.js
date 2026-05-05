import { Router } from 'express'
import { getPool } from '../db/pool.js'

export const analyticsRouter = Router()

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required.')
  return pool
}

async function resolveLiveSessionsTimeExpr(pool) {
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
}

analyticsRouter.get('/overview', async (_req, res) => {
  try {
    const pool = requirePool()
    const [onlineNowQ, newUsersQ, revenueQ, installsQ] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS c FROM live_sessions`),
      pool.query(
        `SELECT COUNT(*)::int AS c
         FROM device_subscriptions
         WHERE started_at >= date_trunc('day', now())`,
      ),
      pool.query(
        `SELECT COALESCE(SUM(amount), 0)::numeric AS s
         FROM transactions
         WHERE lower(status) = 'completed'
           AND created_at >= date_trunc('day', now())`,
      ),
      pool.query(`SELECT COUNT(*)::int AS c FROM app_installs`),
    ])
    res.json({
      onlineNow: Number(onlineNowQ.rows[0]?.c) || 0,
      newUsersToday: Number(newUsersQ.rows[0]?.c) || 0,
      revenueToday: Number(revenueQ.rows[0]?.s) || 0,
      totalInstalls: Number(installsQ.rows[0]?.c) || 0,
    })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

analyticsRouter.get('/channels', async (_req, res) => {
  try {
    const pool = requirePool()
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
    res.status(500).json({ error: String(e.message || e) })
  }
})

analyticsRouter.get('/locations', async (_req, res) => {
  try {
    const pool = requirePool()
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
    res.status(500).json({ error: String(e.message || e) })
  }
})

analyticsRouter.get('/trend', async (_req, res) => {
  try {
    const pool = requirePool()
    const tsCol = await resolveLiveSessionsTimeExpr(pool)
    if (!tsCol) return res.json([])
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
    res.status(500).json({ error: String(e.message || e) })
  }
})

