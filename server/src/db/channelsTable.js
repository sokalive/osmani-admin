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
  /** Optional Mpingo authorized package label; empty = legacy behavior unchanged */
  await client.query(`
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS authorized_package_name TEXT NOT NULL DEFAULT '';
  `)
}
