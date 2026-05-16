import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { tryRecordAppInstall } from '../lib/installAnalytics.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { mergeLocationBucketsByNormalizedLabel, normalizeLocationPayload } from '../lib/analyticsLocation.js'

export const analyticsRouter = Router()

const OVERVIEW_ZERO = {
  onlineNow: 0,
  dauToday: 0,
  newUsersToday: 0,
  revenueToday: 0,
  totalInstalls: 0,
}

const SESSION_TTL_SECONDS = Math.max(30, Number(process.env.ANALYTICS_SESSION_TTL_SECONDS) || 180)
const SESSION_TTL_INTERVAL = `${SESSION_TTL_SECONDS} seconds`

function numOrZero(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

async function safeQueryScalar(pool, sql, label, mapRow, params = []) {
  try {
    const { rows } = await pool.query(sql, params)
    return mapRow(rows[0])
  } catch (e) {
    console.error(`[analytics] ${label}:`, e)
    return null
  }
}

function parseText(v) {
  const s = String(v ?? '').trim()
  return s || null
}

function parseDeviceId(v) {
  const s = parseText(v)
  if (!s) return null
  return s.slice(0, 128)
}

function parseChannelIdFromBody(body) {
  return parseText(
    body?.channel_id ??
      body?.channelId ??
      body?.active_channel_id ??
      body?.activeChannelId ??
      body?.channel,
  )
}

function parseCountryFromBody(body, req) {
  return normalizeLocationPayload(body, req)
}

function parseInstallInstanceId(v) {
  const s = parseText(v)
  if (!s) return ''
  return s.slice(0, 128)
}

/** Mobile sends `install_instance_id`; accept legacy aliases. */
function parseInstallInstanceIdFromBody(body) {
  const b = body && typeof body === 'object' ? body : {}
  return parseInstallInstanceId(
    b.install_instance_id ?? b.installInstanceId ?? b.install_id ?? b.installId,
  )
}

async function cleanupStaleSessions(pool) {
  try {
    await pool.query(
      `DELETE FROM live_sessions
       WHERE COALESCE(updated_at, started_at, now()) < (now() - $1::interval)`,
      [SESSION_TTL_INTERVAL],
    )
  } catch (e) {
    console.error('[analytics] cleanupStaleSessions:', e)
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
    await cleanupStaleSessions(pool)

    const onlineNowRaw = await safeQueryScalar(
      pool,
      `SELECT COUNT(*)::int AS c
       FROM live_sessions
       WHERE COALESCE(updated_at, started_at, now()) >= (now() - $1::interval)`,
      'overview.onlineNow',
      (r) => numOrZero(r?.c),
      [SESSION_TTL_INTERVAL],
    )
    const dauTodayRaw = await safeQueryScalar(
      pool,
      `SELECT COUNT(DISTINCT device_id)::int AS c
       FROM live_sessions
       WHERE COALESCE(updated_at, started_at, now()) >= date_trunc('day', now())`,
      'overview.dauToday',
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
      dauTodayRaw === null ||
      newUsersTodayRaw === null ||
      revenueTodayRaw === null ||
      totalInstallsRaw === null

    res.json({
      onlineNow: onlineNowRaw ?? 0,
      dauToday: dauTodayRaw ?? 0,
      newUsersToday: newUsersTodayRaw ?? 0,
      revenueToday: revenueTodayRaw ?? 0,
      totalInstalls: totalInstallsRaw ?? 0,
      sessionTtlSeconds: SESSION_TTL_SECONDS,
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
    await cleanupStaleSessions(pool)
    const { rows } = await pool.query(
      `SELECT channel_id, COUNT(*)::int AS viewers
       FROM live_sessions
       WHERE channel_id IS NOT NULL
         AND COALESCE(updated_at, started_at, now()) >= (now() - $1::interval)
       GROUP BY channel_id
       ORDER BY viewers DESC`,
      [SESSION_TTL_INTERVAL],
    )
    const mapped = rows.map((r) => ({
      channel_id: String(r.channel_id),
      viewers: Number(r.viewers) || 0,
    }))
    const top5Eligible = mapped.filter((x) => Number(x.viewers) >= 10).slice(0, 5)
    res.json({
      mostWatched: mapped,
      top5: top5Eligible,
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
    await cleanupStaleSessions(pool)
    const { rows } = await pool.query(
      `SELECT country, COUNT(*)::int AS users
       FROM live_sessions
       WHERE country IS NOT NULL AND trim(country) <> ''
         AND COALESCE(updated_at, started_at, now()) >= (now() - $1::interval)
       GROUP BY country
       ORDER BY users DESC`,
      [SESSION_TTL_INTERVAL],
    )
    res.json(mergeLocationBucketsByNormalizedLabel(rows))
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
    const { rows } = await pool.query(
      `SELECT
         bucket AS time,
         SUM(bucket_installs) OVER (ORDER BY bucket)::int AS users
       FROM (
         SELECT
           (
             date_trunc('hour', installed_at)
             + floor(date_part('minute', installed_at) / 5) * interval '5 minutes'
           )::timestamptz AS bucket,
           COUNT(*)::int AS bucket_installs
         FROM app_installs
         WHERE installed_at IS NOT NULL
           AND installed_at >= (now() - interval '24 hours')
         GROUP BY 1
       ) install_buckets
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

analyticsRouter.post('/install', async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) {
      return res.status(503).json({ ok: false, error: 'Database not configured' })
    }
    const deviceId = parseDeviceId(req.body?.device_id)
    if (!deviceId) {
      return res.status(400).json({ ok: false, error: 'device_id is required' })
    }
    const installInstanceId = parseInstallInstanceIdFromBody(req.body)
    const { inserted, deviceId: d, installInstanceId: iid } = await tryRecordAppInstall(
      pool,
      deviceId,
      installInstanceId,
    )
    return res.json({
      ok: true,
      inserted,
      device_id: d,
      install_instance_id: iid,
    })
  } catch (e) {
    console.error('[analytics/install]', e)
    return res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

analyticsRouter.post('/session/start', async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) {
      return res.status(503).json({ ok: false, error: 'Database not configured' })
    }
    const deviceId = parseDeviceId(req.body?.device_id)
    if (!deviceId) {
      return res.status(400).json({ ok: false, error: 'device_id is required' })
    }
    const channelId = parseChannelIdFromBody(req.body)
    const country = parseCountryFromBody(req.body, req)
    await cleanupStaleSessions(pool)
    await pool.query(
      `INSERT INTO live_sessions (device_id, channel_id, country, started_at, updated_at)
       VALUES ($1, $2, $3, now(), now())
       ON CONFLICT (device_id) DO UPDATE SET
         channel_id = EXCLUDED.channel_id,
         country = COALESCE(EXCLUDED.country, live_sessions.country),
         updated_at = now()`,
      [deviceId, channelId, country],
    )
    const iid = parseInstallInstanceIdFromBody(req.body)
    void tryRecordAppInstall(pool, deviceId, iid).catch((e) => {
      console.error('[analytics/session/start] tryRecordAppInstall:', e)
    })
    liveSyncBus.publish('analytics.session_start', { topics: ['analytics'], deviceId })
    return res.json({ ok: true, device_id: deviceId })
  } catch (e) {
    console.error('[analytics/session/start]', e)
    return res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

analyticsRouter.post('/session/heartbeat', async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) {
      return res.status(503).json({ ok: false, error: 'Database not configured' })
    }
    const deviceId = parseDeviceId(req.body?.device_id)
    if (!deviceId) {
      return res.status(400).json({ ok: false, error: 'device_id is required' })
    }
    const channelId = parseChannelIdFromBody(req.body)
    const country = parseCountryFromBody(req.body, req)
    await cleanupStaleSessions(pool)
    await pool.query(
      `INSERT INTO live_sessions (device_id, channel_id, country, started_at, updated_at)
       VALUES ($1, $2, $3, now(), now())
       ON CONFLICT (device_id) DO UPDATE SET
         channel_id = COALESCE(EXCLUDED.channel_id, live_sessions.channel_id),
         country = COALESCE(EXCLUDED.country, live_sessions.country),
         updated_at = now()`,
      [deviceId, channelId, country],
    )
    const iidHb = parseInstallInstanceIdFromBody(req.body)
    void tryRecordAppInstall(pool, deviceId, iidHb).catch((e) => {
      console.error('[analytics/session/heartbeat] tryRecordAppInstall:', e)
    })
    liveSyncBus.publish('analytics.session_heartbeat', { topics: ['analytics'], deviceId })
    return res.json({ ok: true, device_id: deviceId })
  } catch (e) {
    console.error('[analytics/session/heartbeat]', e)
    return res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

analyticsRouter.post('/session/end', async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) {
      return res.status(503).json({ ok: false, error: 'Database not configured' })
    }
    const deviceId = parseDeviceId(req.body?.device_id)
    if (!deviceId) {
      return res.status(400).json({ ok: false, error: 'device_id is required' })
    }
    await pool.query(`DELETE FROM live_sessions WHERE device_id = $1`, [deviceId])
    liveSyncBus.publish('analytics.session_end', { topics: ['analytics'], deviceId })
    return res.json({ ok: true, device_id: deviceId })
  } catch (e) {
    console.error('[analytics/session/end]', e)
    return res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

// App-compatible presence aliases (mobile app integration)
analyticsRouter.post('/presence/start', async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) {
      return res.status(503).json({ ok: false, error: 'Database not configured' })
    }
    const deviceId = parseDeviceId(req.body?.device_id ?? req.body?.deviceId)
    if (!deviceId) {
      return res.status(400).json({ ok: false, error: 'device_id is required' })
    }
    const channelId = parseChannelIdFromBody(req.body)
    const country = parseCountryFromBody(req.body, req)
    await cleanupStaleSessions(pool)
    await pool.query(
      `INSERT INTO live_sessions (device_id, channel_id, country, started_at, updated_at)
       VALUES ($1, $2, $3, now(), now())
       ON CONFLICT (device_id) DO UPDATE SET
         channel_id = COALESCE(EXCLUDED.channel_id, live_sessions.channel_id),
         country = COALESCE(EXCLUDED.country, live_sessions.country),
         updated_at = now()`,
      [deviceId, channelId, country],
    )
    const iidPs = parseInstallInstanceIdFromBody(req.body)
    void tryRecordAppInstall(pool, deviceId, iidPs).catch((e) => {
      console.error('[analytics/presence/start] tryRecordAppInstall:', e)
    })
    liveSyncBus.publish('analytics.session_start', { topics: ['analytics'], deviceId })
    return res.json({ ok: true, device_id: deviceId })
  } catch (e) {
    console.error('[analytics/presence/start]', e)
    return res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

analyticsRouter.post('/presence/heartbeat', async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) {
      return res.status(503).json({ ok: false, error: 'Database not configured' })
    }
    const deviceId = parseDeviceId(req.body?.device_id ?? req.body?.deviceId)
    if (!deviceId) {
      return res.status(400).json({ ok: false, error: 'device_id is required' })
    }
    const channelId = parseChannelIdFromBody(req.body)
    const country = parseCountryFromBody(req.body, req)
    await cleanupStaleSessions(pool)
    await pool.query(
      `INSERT INTO live_sessions (device_id, channel_id, country, started_at, updated_at)
       VALUES ($1, $2, $3, now(), now())
       ON CONFLICT (device_id) DO UPDATE SET
         channel_id = COALESCE(EXCLUDED.channel_id, live_sessions.channel_id),
         country = COALESCE(EXCLUDED.country, live_sessions.country),
         updated_at = now()`,
      [deviceId, channelId, country],
    )
    const iidPh = parseInstallInstanceIdFromBody(req.body)
    void tryRecordAppInstall(pool, deviceId, iidPh).catch((e) => {
      console.error('[analytics/presence/heartbeat] tryRecordAppInstall:', e)
    })
    liveSyncBus.publish('analytics.session_heartbeat', { topics: ['analytics'], deviceId })
    return res.json({ ok: true, device_id: deviceId })
  } catch (e) {
    console.error('[analytics/presence/heartbeat]', e)
    return res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

analyticsRouter.post('/presence/stop', async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) {
      return res.status(503).json({ ok: false, error: 'Database not configured' })
    }
    const deviceId = parseDeviceId(req.body?.device_id ?? req.body?.deviceId)
    if (!deviceId) {
      return res.status(400).json({ ok: false, error: 'device_id is required' })
    }
    await pool.query(`DELETE FROM live_sessions WHERE device_id = $1`, [deviceId])
    liveSyncBus.publish('analytics.session_end', { topics: ['analytics'], deviceId })
    return res.json({ ok: true, device_id: deviceId })
  } catch (e) {
    console.error('[analytics/presence/stop]', e)
    return res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})
