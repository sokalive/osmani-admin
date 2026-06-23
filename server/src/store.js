/**
 * Channel persistence — PostgreSQL (replaces previous JSON file storage).
 * Legacy JSON implementation is preserved as a comment block at the end of this file.
 */
import { normalizePlayerType } from './channelNormalize.js'
import { invalidateChannelAnalyticsIndex } from './lib/channelAnalyticsNormalize.js'
import { ensureChannelsTable } from './db/channelsTable.js'
import { getPool } from './db/pool.js'

function rowToChannel(row) {
  if (!row) return null
  const ca = row.created_at
  const ua = row.updated_at
  return {
    id: Number(row.id),
    name: row.name ?? '',
    url: row.url ?? '',
    thumbnail: row.thumbnail ?? null,
    category: row.category ?? 'General',
    bottomTab: row.bottom_tab ?? 'General',
    isLive: Boolean(row.is_live),
    isHD: Boolean(row.is_hd),
    isActive: Boolean(row.is_active),
    showInApp: Boolean(row.show_in_app),
    accessType: row.access_type === 'premium' ? 'premium' : 'free',
    backupStream1: row.backup_stream_1 ?? '',
    backupStream2: row.backup_stream_2 ?? '',
    origin: row.origin ?? '',
    referer: row.referer ?? '',
    userAgent: row.user_agent ?? '',
    playerType: normalizePlayerType(row.player_type),
    sortOrder: Number(row.sort_order) || 0,
    createdAt: ca instanceof Date ? ca.toISOString() : ca,
    updatedAt: ua instanceof Date ? ua.toISOString() : ua,
  }
}

function channelToRowParams(c) {
  return [
    Number(c.id),
    c.name ?? '',
    c.url ?? '',
    c.thumbnail ?? null,
    c.category ?? 'General',
    c.bottomTab ?? 'General',
    Boolean(c.isLive),
    Boolean(c.isHD),
    Boolean(c.isActive),
    Boolean(c.showInApp),
    c.accessType === 'premium' ? 'premium' : 'free',
    c.backupStream1 ?? '',
    c.backupStream2 ?? '',
    c.origin ?? '',
    c.referer ?? '',
    c.userAgent ?? '',
    normalizePlayerType(c.playerType),
    Number(c.sortOrder) || 0,
    c.createdAt ?? new Date().toISOString(),
    c.updatedAt ?? new Date().toISOString(),
  ]
}

/** Ensures DB pool + channels table exist (replaces legacy channels.json creation). */
export async function ensureDataFile() {
  const pool = getPool()
  if (!pool) {
    throw new Error('DATABASE_URL is required for channel storage (PostgreSQL).')
  }
  const client = await pool.connect()
  try {
    await ensureChannelsTable(client)
  } finally {
    client.release()
  }
}

export async function readChannels() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required for channel storage.')
  const { rows } = await pool.query(
    `SELECT id, name, url, thumbnail, category, bottom_tab, is_live, is_hd, is_active, show_in_app,
            access_type, backup_stream_1, backup_stream_2, origin, referer, user_agent, player_type,
            sort_order, created_at, updated_at
     FROM channels ORDER BY sort_order ASC, id ASC`,
  )
  return rows.map(rowToChannel)
}

/** Lightweight id → name map for admin analytics (no stream URLs). */
let _channelIdNameMapCache = null
let _channelIdNameMapCacheAt = 0
const CHANNEL_ID_NAME_MAP_TTL_MS = Math.max(
  5000,
  Number(process.env.CHANNEL_ID_NAME_MAP_TTL_MS) || 60_000,
)

export async function readChannelIdNameMap() {
  const now = Date.now()
  if (_channelIdNameMapCache && now - _channelIdNameMapCacheAt < CHANNEL_ID_NAME_MAP_TTL_MS) {
    return _channelIdNameMapCache
  }
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required for channel storage.')
  const { rows } = await pool.query(
    `SELECT id::text AS id, name FROM channels ORDER BY sort_order ASC, id ASC`,
  )
  const map = {}
  for (const row of rows) {
    const id = String(row.id ?? '').trim()
    if (!id) continue
    map[id] = String(row.name ?? '').trim() || id
  }
  _channelIdNameMapCache = map
  _channelIdNameMapCacheAt = now
  return map
}

export function invalidateChannelIdNameMapCache() {
  _channelIdNameMapCache = null
  _channelIdNameMapCacheAt = 0
  invalidateChannelAnalyticsIndex()
}

export async function getNextChannelId() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required for channel storage.')
  const { rows } = await pool.query('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM channels')
  return Number(rows[0]?.n ?? 1)
}

export async function getChannelById(id) {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required for channel storage.')
  const { rows } = await pool.query(
    `SELECT id, name, url, thumbnail, category, bottom_tab, is_live, is_hd, is_active, show_in_app,
            access_type, backup_stream_1, backup_stream_2, origin, referer, user_agent, player_type,
            sort_order, created_at, updated_at
     FROM channels WHERE id = $1`,
    [Number(id)],
  )
  return rows.length ? rowToChannel(rows[0]) : null
}

export async function insertChannel(c) {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required for channel storage.')
  const p = channelToRowParams(c)
  await pool.query(
    `INSERT INTO channels (
       id, name, url, thumbnail, category, bottom_tab, is_live, is_hd, is_active, show_in_app,
       access_type, backup_stream_1, backup_stream_2, origin, referer, user_agent, player_type,
       sort_order, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::timestamptz,$20::timestamptz)`,
    p,
  )
}

export async function updateChannel(c) {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required for channel storage.')
  const p = channelToRowParams(c)
  await pool.query(
    `UPDATE channels SET
       name = $2, url = $3, thumbnail = $4, category = $5, bottom_tab = $6,
       is_live = $7, is_hd = $8, is_active = $9, show_in_app = $10, access_type = $11,
       backup_stream_1 = $12, backup_stream_2 = $13, origin = $14, referer = $15, user_agent = $16,
       player_type = $17, sort_order = $18, created_at = $19::timestamptz, updated_at = $20::timestamptz
     WHERE id = $1`,
    p,
  )
}

export async function deleteChannelById(id) {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required for channel storage.')
  await pool.query('DELETE FROM channels WHERE id = $1', [Number(id)])
}

export async function reorderChannels(orders) {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required for channel storage.')
  const list = Array.isArray(orders) ? orders : []
  if (list.length === 0) return 0
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    let n = 0
    for (const item of list) {
      const id = Number(item?.id)
      const sortOrder = Number(item?.sortOrder ?? item?.sort_order)
      if (!Number.isFinite(id) || !Number.isFinite(sortOrder)) continue
      await client.query(
        `UPDATE channels SET sort_order = $2, updated_at = now() WHERE id = $1`,
        [id, sortOrder],
      )
      n += 1
    }
    await client.query('COMMIT')
    return n
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

export async function getNextChannelSortOrder() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required for channel storage.')
  const { rows } = await pool.query(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM channels`)
  return Number(rows[0]?.n ?? 1)
}

/**
 * @deprecated Used with JSON storage to replace the whole file. PostgreSQL routes use row CRUD instead.
 */
export async function writeChannels(_channels) {
  console.warn('[store] writeChannels() is deprecated with PostgreSQL — use insertChannel / updateChannel / deleteChannelById')
}

/* -------------------------------------------------------------------------- */
/* Legacy JSON storage (reference — not executed)                             */
/* -------------------------------------------------------------------------- */
/*
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_PATH = path.join(__dirname, '../data/channels.json')
const TMP_PATH = `${DATA_PATH}.tmp`

export async function ensureDataFile() {
  await fs.mkdir(path.dirname(DATA_PATH), { recursive: true })
  try {
    await fs.access(DATA_PATH)
  } catch {
    await fs.writeFile(DATA_PATH, '[]\n', 'utf8')
  }
}

export async function readChannels() {
  try {
    const raw = await fs.readFile(DATA_PATH, 'utf8')
    const parsed = JSON.parse(raw || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function writeChannels(channels) {
  const payload = `${JSON.stringify(channels, null, 2)}\n`
  try {
    await fs.writeFile(TMP_PATH, payload, 'utf8')
    await fs.rename(TMP_PATH, DATA_PATH)
  } catch (e) {
    await fs.unlink(TMP_PATH).catch(() => {})
    throw e
  }
}
*/
