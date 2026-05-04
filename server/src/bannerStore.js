import { ensureBannersTable } from './db/bannersTable.js'
import { getPool } from './db/pool.js'

export async function ensureBannersStorage() {
  const pool = getPool()
  if (!pool) {
    throw new Error('DATABASE_URL is required for banner storage (PostgreSQL).')
  }
  const client = await pool.connect()
  try {
    await ensureBannersTable(client)
  } finally {
    client.release()
  }
}

const SELECT_BASE = `
  SELECT b.id, b.title, b.description, b.image, b.active, b.enabled, b.badge,
         b.badge_enabled, b.badge_color, b.badge_blink, b.badge_priority,
         b.enable_countdown, b.event_start, b.event_end,
         b.redirect_channel_id, b.sort_order, b.event_timer, b.daily_start, b.daily_end, b.created_at,
         c.name AS redirect_channel_name
  FROM banners b
  LEFT JOIN channels c ON c.id = b.redirect_channel_id
`

const DAILY_WINDOW_SQL = `
  (
    b.event_timer = false
    OR (
      b.daily_start IS NOT NULL
      AND b.daily_end IS NOT NULL
      AND (
        (b.daily_start <= b.daily_end AND CURRENT_TIME >= b.daily_start AND CURRENT_TIME <= b.daily_end)
        OR
        (b.daily_start > b.daily_end AND (CURRENT_TIME >= b.daily_start OR CURRENT_TIME <= b.daily_end))
      )
    )
  )
`

/** Event range: no bounds → pass; partial bounds → open-ended; both → closed interval. */
const EVENT_RANGE_SQL = `
  (
    (b.event_start IS NULL AND b.event_end IS NULL)
    OR (
      (b.event_start IS NULL OR NOW() >= b.event_start)
      AND (b.event_end IS NULL OR NOW() <= b.event_end)
    )
  )
`

/** Public list: active + enabled + event window + legacy daily timer when event_timer is on. */
export async function listBannersPublic() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required.')
  const { rows } = await pool.query(`
    ${SELECT_BASE}
    WHERE b.active = true AND b.enabled = true
      AND ${EVENT_RANGE_SQL}
      AND ${DAILY_WINDOW_SQL}
    ORDER BY b.sort_order ASC, b.created_at DESC
  `)
  return rows
}

/** Admin / CMS: all banners. */
export async function listBannersManage() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required.')
  const { rows } = await pool.query(`${SELECT_BASE} ORDER BY b.sort_order ASC, b.created_at DESC`)
  return rows
}

export async function getBannerById(id) {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required.')
  const { rows } = await pool.query(`${SELECT_BASE} WHERE b.id = $1`, [Number(id)])
  return rows[0] ?? null
}

export async function insertBanner(payload) {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required.')
  const { rows } = await pool.query(
    `INSERT INTO banners (
       title, description, image, active, enabled, badge,
       badge_enabled, badge_color, badge_blink, badge_priority,
       enable_countdown, event_start, event_end,
       redirect_channel_id, sort_order,
       event_timer, daily_start, daily_end
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz,$13::timestamptz,$14,$15,$16,$17::time,$18::time)
     RETURNING id`,
    [
      payload.title,
      payload.description,
      payload.image,
      payload.active,
      payload.enabled,
      payload.badge,
      payload.badge_enabled,
      payload.badge_color,
      payload.badge_blink,
      payload.badge_priority,
      payload.enable_countdown,
      payload.event_start,
      payload.event_end,
      payload.redirect_channel_id,
      payload.sort_order,
      payload.event_timer,
      payload.daily_start,
      payload.daily_end,
    ],
  )
  return rows[0]
}

export async function updateBanner(id, payload) {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required.')
  const { rows } = await pool.query(
    `UPDATE banners SET
       title = $2, description = $3, image = $4, active = $5, enabled = $6, badge = $7,
       badge_enabled = $8, badge_color = $9, badge_blink = $10, badge_priority = $11,
       enable_countdown = $12, event_start = $13::timestamptz, event_end = $14::timestamptz,
       redirect_channel_id = $15, sort_order = $16, event_timer = $17,
       daily_start = $18::time, daily_end = $19::time
     WHERE id = $1
     RETURNING id`,
    [
      Number(id),
      payload.title,
      payload.description,
      payload.image,
      payload.active,
      payload.enabled,
      payload.badge,
      payload.badge_enabled,
      payload.badge_color,
      payload.badge_blink,
      payload.badge_priority,
      payload.enable_countdown,
      payload.event_start,
      payload.event_end,
      payload.redirect_channel_id,
      payload.sort_order,
      payload.event_timer,
      payload.daily_start,
      payload.daily_end,
    ],
  )
  return rows[0] ?? null
}

export async function deleteBannerById(id) {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required.')
  await pool.query('DELETE FROM banners WHERE id = $1', [Number(id)])
}
