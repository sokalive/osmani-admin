/**
 * Banners table — hero / promo tiles with optional daily window.
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
      redirect_channel_id INTEGER REFERENCES channels (id) ON DELETE SET NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      event_timer BOOLEAN NOT NULL DEFAULT false,
      daily_start TIME,
      daily_end TIME,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS banners_sort_order_idx ON banners (sort_order);
  `)
}
