import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { tryRecordAppInstall } from '../lib/installAnalytics.js'
import {
  LIVE_PRESENCE_WINDOW_SECONDS,
  SESSION_PRUNE_SECONDS,
  startLivePresenceJanitor,
} from '../lib/livePresence.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import {
  aggregateLocationsByPlace,
  resolveLocationLabel,
  sumLocationsOnline,
} from '../lib/analyticsLocation.js'
import { parseChannelRefFromPayload, parseChannelClearFromPayload, TOP5_MIN_VIEWERS } from '../lib/analyticsPresence.js'
import {
  queryLiveChannelStats,
  queryLiveLocationBuckets,
  queryLivePresenceTotals,
  sumChannelViewers,
} from '../lib/livePresenceStats.js'
import { queryMigrationDevicePopulationSummary } from '../lib/appVersionMigration.js'
import { queryCanonicalUniqueDeviceCount } from '../lib/canonicalUniqueDevices.js'
import {
  peekPhysicalDeviceCensusCache,
  schedulePhysicalDeviceCensusRefresh,
} from '../lib/canonicalPhysicalDeviceCensus.js'
import { upsertLiveSession, removeLiveSession } from '../lib/liveSessionStore.js'
import { readChannelIdNameMap } from '../store.js'

export const analyticsRouter = Router()

startLivePresenceJanitor()
setTimeout(() => schedulePhysicalDeviceCensusRefresh(), 45_000)

const OVERVIEW_ZERO = {
  onlineNow: 0,
  watchingNow: 0,
  idleNow: 0,
  dauToday: 0,
  newUsersToday: 0,
  revenueToday: 0,
  totalInstalls: 0,
  totalUniqueDevices: 0,
}

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


function parseChannelRefFromBody(body) {
  const b = body && typeof body === 'object' ? body : {}
  return parseChannelRefFromPayload(b)
}

function parseChannelClearFromBody(body) {
  const b = body && typeof body === 'object' ? body : {}
  return parseChannelClearFromPayload(b)
}

async function parseCountryFromBody(body, req) {
  return resolveLocationLabel(body, req)
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

async function queryOverviewStats(pool) {
  const physicalCensusPeek = peekPhysicalDeviceCensusCache()
  if (!physicalCensusPeek || physicalCensusPeek.stale) {
    schedulePhysicalDeviceCensusRefresh()
  }

  const [
    presenceTotals,
    dauTodayRaw,
    newUsersTodayRaw,
    revenueTodayRaw,
    totalInstallsRaw,
    canonicalUnique,
  ] = await Promise.all([
      queryLivePresenceTotals(pool).catch((e) => {
        console.error('[analytics] overview.presenceTotals:', e)
        return null
      }),
      safeQueryScalar(
        pool,
        `SELECT COUNT(DISTINCT device_id)::int AS c
     FROM live_sessions
     WHERE COALESCE(updated_at, started_at, now()) >= date_trunc('day', now())`,
        'overview.dauToday',
        (r) => numOrZero(r?.c),
      ),
      safeQueryScalar(
        pool,
        `SELECT COUNT(*)::int AS c
     FROM device_subscriptions
     WHERE started_at >= date_trunc('day', now())`,
        'overview.newUsersToday',
        (r) => numOrZero(r?.c),
      ),
      safeQueryScalar(
        pool,
        `SELECT COALESCE(SUM(amount), 0)::numeric AS s
     FROM transactions
     WHERE lower(status) = 'completed'
       AND created_at >= date_trunc('day', now())`,
        'overview.revenueToday',
        (r) => numOrZero(r?.s),
      ),
      safeQueryScalar(
        pool,
        `SELECT COUNT(*)::int AS c FROM app_installs`,
        'overview.totalInstalls',
        (r) => numOrZero(r?.c),
      ),
      queryCanonicalUniqueDeviceCount().catch((e) => {
        console.error('[analytics] overview.canonicalUniqueDevices:', e)
        return { ok: false, totalUniqueDevices: 0 }
      }),
    ])
  const physicalCensus = physicalCensusPeek
  let totalUniqueDevices = 0
  let totalUniqueDevicesMethod = 'unknown'
  if (physicalCensus?.ok && physicalCensus.counts?.physical_device_components_total != null) {
    totalUniqueDevices = numOrZero(physicalCensus.counts.physical_device_components_total)
    totalUniqueDevicesMethod = physicalCensus.stale
      ? 'physical_device_graph_v1_stale_cache'
      : 'physical_device_graph_v1'
  } else if (canonicalUnique?.ok && canonicalUnique.totalUniqueDevices != null) {
    totalUniqueDevices = numOrZero(canonicalUnique.totalUniqueDevices)
    totalUniqueDevicesMethod = 'canonical_observed_identities_fallback'
  } else {
    const migrationSummary = await queryMigrationDevicePopulationSummary().catch((e) => {
      console.error('[analytics] overview.totalUniqueDevices fallback:', e)
      return { ok: false }
    })
    totalUniqueDevices =
      migrationSummary?.ok && migrationSummary.summary
        ? numOrZero(migrationSummary.summary.totalUniqueDevices)
        : 0
    totalUniqueDevicesMethod = 'legacy_migration_fallback'
  }
  const onlineNow = presenceTotals?.onlineNow ?? 0
  const watchingNow = presenceTotals?.watchingNow ?? 0
  const idleNow = presenceTotals?.idleNow ?? 0
  const degraded =
    presenceTotals === null ||
    dauTodayRaw === null ||
    newUsersTodayRaw === null ||
    revenueTodayRaw === null ||
    totalInstallsRaw === null
  return {
    onlineNow,
    watchingNow,
    idleNow,
    dauToday: dauTodayRaw ?? 0,
    newUsersToday: newUsersTodayRaw ?? 0,
    revenueToday: revenueTodayRaw ?? 0,
    totalInstalls: totalInstallsRaw ?? 0,
    totalUniqueDevices,
    totalUniqueDevicesMethod,
    totalUniqueDevicesHighConfidence: physicalCensus?.ok
      ? numOrZero(physicalCensus.counts?.high_confidence_physical_devices)
      : null,
    totalUniqueDevicesAmbiguous: physicalCensus?.ok
      ? numOrZero(physicalCensus.counts?.ambiguous_low_confidence_components)
      : null,
    livePresenceWindowSeconds: LIVE_PRESENCE_WINDOW_SECONDS,
    sessionPruneSeconds: SESSION_PRUNE_SECONDS,
    sessionTtlSeconds: LIVE_PRESENCE_WINDOW_SECONDS,
    degraded,
  }
}

async function queryChannelStats(pool) {
  const mapped = await queryLiveChannelStats(pool)
  return {
    mostWatched: mapped,
    top5: mapped.filter((x) => x.viewers >= TOP5_MIN_VIEWERS).slice(0, 5),
    top5MinViewers: TOP5_MIN_VIEWERS,
    watchingNow: sumChannelViewers(mapped),
  }
}

async function queryLocationStats(pool) {
  const rows = await queryLiveLocationBuckets(pool)
  return aggregateLocationsByPlace(rows)
}

analyticsRouter.get('/snapshot', async (_req, res) => {
  try {
    const pool = getPool()
    if (!pool) {
      return res.status(200).json({
        ...OVERVIEW_ZERO,
        mostWatched: [],
        top5: [],
        locations: [],
        top5MinViewers: TOP5_MIN_VIEWERS,
        degraded: true,
        error: 'Database not configured',
      })
    }
    const [overview, channels, locations, channelLabels] = await Promise.all([
      queryOverviewStats(pool),
      queryChannelStats(pool),
      queryLocationStats(pool),
      readChannelIdNameMap().catch((e) => {
        console.error('[analytics/snapshot] channelLabels:', e)
        return {}
      }),
    ])
    const locationsOnline = sumLocationsOnline(locations)
    const watchingFromChannels = channels.watchingNow ?? sumChannelViewers(channels.mostWatched)
    res.json({
      ...overview,
      onlineNow: overview.onlineNow,
      watchingNow: overview.watchingNow ?? watchingFromChannels,
      idleNow: overview.idleNow ?? Math.max(0, overview.onlineNow - watchingFromChannels),
      locationsOnline,
      channelWatchingNow: watchingFromChannels,
      mostWatched: channels.mostWatched,
      top5: channels.top5,
      top5MinViewers: TOP5_MIN_VIEWERS,
      channelLabels,
      locations,
      snapshotAt: new Date().toISOString(),
      ...(overview.degraded ? { degraded: true } : {}),
    })
  } catch (e) {
    console.error('[analytics/snapshot]', e)
    res.status(200).json({
      ...OVERVIEW_ZERO,
      mostWatched: [],
      top5: [],
      locations: [],
      top5MinViewers: TOP5_MIN_VIEWERS,
      degraded: true,
      error: String(e.message || e),
    })
  }
})

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
    const stats = await queryOverviewStats(pool)
    const { degraded, ...body } = stats
    res.json({ ...body, ...(degraded ? { degraded: true } : {}) })
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
    const channels = await queryChannelStats(pool)
    res.json(channels)
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
    res.json(await queryLocationStats(pool))
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
    const channelRef = parseChannelRefFromBody(req.body)
    const clearChannel = parseChannelClearFromBody(req.body)
    const country = await parseCountryFromBody(req.body, req)
    await upsertLiveSession(pool, {
      deviceId,
      channelId: channelRef.channelId,
      channelName: channelRef.channelName,
      country,
      installBody: req.body,
      clearChannel,
    })
    liveSyncBus.publish('analytics.session_start', { topics: ['analytics'], deviceId })
    return res.json({ ok: true, device_id: deviceId })
  } catch (e) {
    console.error('[analytics/session/start]', e)
    return res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** Shared heartbeat for /analytics/session/* and legacy root /session/ping, /live/ping. */
export async function handleLiveSessionHeartbeat(req, res) {
  try {
    const pool = getPool()
    if (!pool) {
      return res.status(503).json({ ok: false, error: 'Database not configured' })
    }
    const deviceId = parseDeviceId(req.body?.device_id ?? req.body?.deviceId)
    if (!deviceId) {
      return res.status(400).json({ ok: false, error: 'device_id is required' })
    }
    const channelRef = parseChannelRefFromBody(req.body)
    const clearChannel = parseChannelClearFromBody(req.body)
    const country = await parseCountryFromBody(req.body, req)
    await upsertLiveSession(pool, {
      deviceId,
      channelId: channelRef.channelId,
      channelName: channelRef.channelName,
      country,
      installBody: req.body,
      clearChannel,
    })
    liveSyncBus.publish('analytics.session_heartbeat', { topics: ['analytics'], deviceId })
    return res.json({ ok: true, device_id: deviceId })
  } catch (e) {
    console.error('[analytics/session/heartbeat]', e)
    return res.status(500).json({ ok: false, error: String(e.message || e) })
  }
}

analyticsRouter.post('/session/heartbeat', handleLiveSessionHeartbeat)
analyticsRouter.post('/session/ping', handleLiveSessionHeartbeat)
analyticsRouter.post('/live/ping', handleLiveSessionHeartbeat)

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
    await removeLiveSession(pool, deviceId)
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
    const channelRef = parseChannelRefFromBody(req.body)
    const clearChannel = parseChannelClearFromBody(req.body)
    const country = await parseCountryFromBody(req.body, req)
    await upsertLiveSession(pool, {
      deviceId,
      channelId: channelRef.channelId,
      channelName: channelRef.channelName,
      country,
      installBody: req.body,
      clearChannel,
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
    const channelRef = parseChannelRefFromBody(req.body)
    const clearChannel = parseChannelClearFromBody(req.body)
    const country = await parseCountryFromBody(req.body, req)
    await upsertLiveSession(pool, {
      deviceId,
      channelId: channelRef.channelId,
      channelName: channelRef.channelName,
      country,
      installBody: req.body,
      clearChannel,
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
    await removeLiveSession(pool, deviceId)
    liveSyncBus.publish('analytics.session_end', { topics: ['analytics'], deviceId })
    return res.json({ ok: true, device_id: deviceId })
  } catch (e) {
    console.error('[analytics/presence/stop]', e)
    return res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})
