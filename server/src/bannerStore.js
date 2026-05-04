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
         b.redirect_channel_id, b.sort_order, b.event_timer, b.daily_start, b.daily_end, b.created_at,
         c.name AS redirect_channel_name
  FROM banners b
  LEFT JOIN channels c ON c.id = b.redirect_channel_id
`

/** Public list: active + enabled + optional daily window (server local time). */
export async function listBannersPublic() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required.')
  const { rows } = await pool.query(`
    ${SELECT_BASE}
    WHERE b.active = true AND b.enabled = true
      AND (
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
    ORDER BY b.sort_order ASC, b.id ASC
  `)
  return rows
}

/** Admin / CMS: all banners. */
export async function listBannersManage() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required.')
  const { rows } = await pool.query(`${SELECT_BASE} ORDER BY b.sort_order ASC, b.id ASC`)
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
       title, description, image, active, enabled, badge, redirect_channel_id, sort_order,
       event_timer, daily_start, daily_end
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::time,$11::time)
     RETURNING id`,
    [
      payload.title,
      payload.description,
      payload.image,
      payload.active,
      payload.enabled,
      payload.badge,
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
       redirect_channel_id = $8, sort_order = $9, event_timer = $10,
       daily_start = $11::time, daily_end = $12::time
     WHERE id = $1
     RETURNING id, title, description, image, active, enabled, badge, redirect_channel_id, sort_order,
               event_timer, daily_start, daily_end, created_at`,
    [
      Number(id),
      payload.title,
      payload.description,
      payload.image,
      payload.active,
      payload.enabled,
      payload.badge,
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
