import { INSTRUCTION_VIDEO_CHANNEL_NAME, INSTRUCTION_VISIBILITY } from './instructionVideoChannel.js'

/**
 * Ensures the system VIDEO instruction channel exists and is locked/free.
 */
export async function ensureInstructionVideoChannel(client) {
  const { rows } = await client.query(
    `SELECT id FROM channels WHERE upper(trim(name)) = $1 ORDER BY id ASC LIMIT 1`,
    [INSTRUCTION_VIDEO_CHANNEL_NAME],
  )
  if (rows[0]) {
    await client.query(
      `UPDATE channels SET
         channel_kind = 'instruction_video',
         is_system_locked = true,
         access_type = 'free',
         is_live = false,
         player_type = COALESCE(NULLIF(trim(player_type), ''), 'exo'),
         instruction_visibility = COALESCE(NULLIF(trim(instruction_visibility), ''), $2),
         updated_at = now()
       WHERE id = $1`,
      [rows[0].id, INSTRUCTION_VISIBILITY.ALL],
    )
    return Number(rows[0].id)
  }

  const { rows: idRows } = await client.query(`SELECT COALESCE(MAX(id), 0) + 1 AS n FROM channels`)
  const id = Number(idRows[0]?.n ?? 1)
  const { rows: sortRows } = await client.query(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM channels`)
  const sortOrder = Number(sortRows[0]?.n ?? id)
  await client.query(
    `INSERT INTO channels (
       id, name, url, thumbnail, category, bottom_tab, is_live, is_hd, is_active, show_in_app,
       access_type, backup_stream_1, backup_stream_2, origin, referer, user_agent, player_type,
       sort_order, channel_kind, instruction_visibility, is_system_locked, created_at, updated_at
     ) VALUES (
       $1, $2, '', NULL, 'Home', 'Home', false, true, true, true,
       'free', '', '', '', '', '', 'exo',
       $3, 'instruction_video', $4, true, now(), now()
     )`,
    [id, INSTRUCTION_VIDEO_CHANNEL_NAME, sortOrder, INSTRUCTION_VISIBILITY.ALL],
  )
  return id
}
