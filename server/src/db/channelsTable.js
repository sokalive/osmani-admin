/**
 * Creates the `channels` table if it does not exist.
 * Columns beyond name/url/thumbnail/created_at preserve the existing JSON API shape.
 */
export async function ensureChannelsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      thumbnail TEXT,
      category TEXT NOT NULL DEFAULT 'General',
      bottom_tab TEXT NOT NULL DEFAULT 'General',
      is_live BOOLEAN NOT NULL DEFAULT true,
      is_hd BOOLEAN NOT NULL DEFAULT true,
      is_active BOOLEAN NOT NULL DEFAULT true,
      show_in_app BOOLEAN NOT NULL DEFAULT true,
      access_type TEXT NOT NULL DEFAULT 'free',
      backup_stream_1 TEXT NOT NULL DEFAULT '',
      backup_stream_2 TEXT NOT NULL DEFAULT '',
      origin TEXT NOT NULL DEFAULT '',
      referer TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      player_type TEXT NOT NULL DEFAULT 'exo',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT channels_access_type_check CHECK (access_type IN ('free', 'premium'))
    );
  `)
  await client.query(`
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
  `)
  await client.query(`
    UPDATE channels SET sort_order = id WHERE sort_order IS NULL OR sort_order = 0;
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS channels_sort_order_idx ON channels (sort_order ASC, id ASC);
  `)
  await client.query(`
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS channel_kind TEXT NOT NULL DEFAULT 'standard';
  `)
  await client.query(`
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS instruction_visibility TEXT NOT NULL DEFAULT 'all';
  `)
  await client.query(`
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_system_locked BOOLEAN NOT NULL DEFAULT false;
  `)
  await client.query(`
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS instruction_video_url TEXT NOT NULL DEFAULT '';
  `)
  await client.query(`
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS instruction_video_status TEXT NOT NULL DEFAULT '';
  `)
  await client.query(`
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS instruction_video_file_size BIGINT;
  `)
  await client.query(`
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS instruction_video_duration_sec DOUBLE PRECISION;
  `)
  await client.query(`
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS instruction_video_width INTEGER;
  `)
  await client.query(`
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS instruction_video_height INTEGER;
  `)
  await client.query(`
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS instruction_video_uploaded_at TIMESTAMPTZ;
  `)
  await client.query(`
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS instruction_video_uploaded_by TEXT NOT NULL DEFAULT '';
  `)
  await client.query(`
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS instruction_video_checksum TEXT NOT NULL DEFAULT '';
  `)
  await client.query(`
    UPDATE channels
    SET url = regexp_replace(instruction_video_url, '^https?://[^/]+', '')
    WHERE lower(trim(channel_kind)) = 'instruction_video'
      AND instruction_video_url LIKE 'https://%/uploads/videos/%'
      AND (
        url IS NULL
        OR url = ''
        OR url IS DISTINCT FROM regexp_replace(instruction_video_url, '^https?://[^/]+', '')
      )
  `)
  const { ensureInstructionVideoChannel } = await import('../lib/instructionVideoChannelBootstrap.js')
  await ensureInstructionVideoChannel(client)
}
