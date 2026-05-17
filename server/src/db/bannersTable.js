/**
 * Banners table — hero / promo tiles with optional daily window and event range.
 */
export async function ensureBannersTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS banners (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      image TEXT,
      active BOOLEAN NOT NULL DEFAULT true,
      enabled BOOLEAN NOT NULL DEFAULT true,
      badge TEXT NOT NULL DEFAULT '',
      badge_enabled BOOLEAN NOT NULL DEFAULT true,
      badge_color TEXT NOT NULL DEFAULT '#FBBF24',
      badge_blink BOOLEAN NOT NULL DEFAULT false,
      badge_priority INTEGER NOT NULL DEFAULT 0,
      enable_countdown BOOLEAN NOT NULL DEFAULT false,
      event_start TIMESTAMPTZ,
      event_end TIMESTAMPTZ,
      redirect_channel_id INTEGER REFERENCES channels (id) ON DELETE SET NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      event_timer BOOLEAN NOT NULL DEFAULT false,
      daily_start TIME,
      daily_end TIME,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS banners_sort_order_idx ON banners (sort_order);
  `)

  const alters = [
    `ALTER TABLE banners ADD COLUMN IF NOT EXISTS badge_enabled BOOLEAN NOT NULL DEFAULT true`,
    `ALTER TABLE banners ADD COLUMN IF NOT EXISTS badge_color TEXT NOT NULL DEFAULT '#FBBF24'`,
    `ALTER TABLE banners ADD COLUMN IF NOT EXISTS badge_blink BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE banners ADD COLUMN IF NOT EXISTS badge_priority INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE banners ADD COLUMN IF NOT EXISTS enable_countdown BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE banners ADD COLUMN IF NOT EXISTS event_start TIMESTAMPTZ`,
    `ALTER TABLE banners ADD COLUMN IF NOT EXISTS event_end TIMESTAMPTZ`,
  ]
  for (const sql of alters) {
    await client.query(sql)
  }

  await client.query(`
    ALTER TABLE banners ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
  `)
  await client.query(`
    ALTER TABLE banners ADD COLUMN IF NOT EXISTS runtime_position TEXT DEFAULT 'center';
  `)
}
