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

/** Admin / detail: full row + optional channel name for CMS. */
const SELECT_BASE = `
  SELECT b.id, b.title, b.description, b.image, b.active, b.enabled, b.badge,
         b.badge_automation, b.badge_enabled, b.badge_color, b.badge_blink, b.badge_priority,
         b.enable_countdown, b.event_start, b.event_end,
         b.redirect_channel_id, b.sort_order, b.event_timer, b.daily_start, b.daily_end,
         b.created_at, b.updated_at,
         c.name AS redirect_channel_name
  FROM banners b
  LEFT JOIN channels c ON c.id = b.redirect_channel_id
`

/** Public list: spec fields only (no join). */
const SELECT_PUBLIC = `
  SELECT b.id, b.title, b.description, b.image,
         b.active, b.badge, b.badge_automation, b.badge_enabled, b.badge_color, b.badge_blink, b.badge_priority,
         b.enable_countdown, b.event_start, b.event_end,
         b.redirect_channel_id, b.sort_order, b.event_timer, b.daily_start, b.daily_end,
         b.created_at, b.updated_at
  FROM banners b
`

/**
 * Non-ended banners only: includes upcoming (future event_start) for COMING SOON / NEXT badges.
 * Daily repeat window is evaluated in Node (bannerScheduleEngine), not SQL.
 */
const PUBLIC_VISIBILITY_WHERE = `
  b.active = true
  AND (b.event_end IS NULL OR NOW() < b.event_end)
`

/** Public GET /api/banners — production spec only (no enabled / daily timer filter). */
export async function listBannersPublic() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required.')
  const { rows } = await pool.query(`
    ${SELECT_PUBLIC}
    WHERE ${PUBLIC_VISIBILITY_WHERE}
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
       title, description, image, active, enabled, badge, badge_automation,
       badge_enabled, badge_color, badge_blink, badge_priority,
       enable_countdown, event_start, event_end,
       redirect_channel_id, sort_order,
       event_timer, daily_start, daily_end
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::timestamptz,$14::timestamptz,$15,$16,$17,$18::time,$19::time)
     RETURNING id`,
    [
      payload.title,
      payload.description,
      payload.image,
      payload.active,
      payload.enabled,
      payload.badge,
      payload.badge_automation,
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
       title = $2, description = $3, image = $4, active = $5, enabled = $6, badge = $7, badge_automation = $8,
       badge_enabled = $9, badge_color = $10, badge_blink = $11, badge_priority = $12,
       enable_countdown = $13, event_start = $14::timestamptz, event_end = $15::timestamptz,
       redirect_channel_id = $16, sort_order = $17, event_timer = $18,
       daily_start = $19::time, daily_end = $20::time,
       updated_at = now()
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
      payload.badge_automation,
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
