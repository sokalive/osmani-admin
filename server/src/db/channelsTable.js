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
      display_section TEXT NOT NULL DEFAULT 'general',
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
      CONSTRAINT channels_access_type_check CHECK (access_type IN ('free', 'premium')),
      CONSTRAINT channels_display_section_check CHECK (
        display_section IN ('general', 'sports', 'movies', 'kids', 'news', 'music', 'docs')
      )
    );
  `)

  await client.query(`
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS display_section TEXT NOT NULL DEFAULT 'general';
  `)

  /** Backfill legacy rows from category labels when display_section wasn't available. */
  await client.query(`
    UPDATE channels
    SET display_section = CASE LOWER(TRIM(COALESCE(category, '')))
      WHEN 'sports' THEN 'sports'
      WHEN 'movies' THEN 'movies'
      WHEN 'kids' THEN 'kids'
      WHEN 'news' THEN 'news'
      WHEN 'music' THEN 'music'
      WHEN 'docs' THEN 'docs'
      WHEN 'general' THEN 'general'
      ELSE 'general'
    END
    WHERE display_section IS NULL OR TRIM(display_section) = '';
  `)
}
