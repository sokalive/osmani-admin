/**
 * Billing: plans, transactions, subscriptions, ZenoPay settings (single-row).
 */
export async function ensureBillingTables(client) {
  await client.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`)

  await client.query(`
    CREATE TABLE IF NOT EXISTS app_installs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      device_id TEXT NOT NULL DEFAULT '',
      installed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS app_installs_device_id_idx ON app_installs (device_id);
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS app_installs_installed_at_idx ON app_installs (installed_at DESC);
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS live_sessions (
      device_id TEXT NOT NULL DEFAULT '',
      channel_id TEXT,
      country TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS live_sessions_channel_id_idx ON live_sessions (channel_id);
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS live_sessions_country_idx ON live_sessions (country);
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS live_sessions_updated_at_idx ON live_sessions (updated_at DESC);
  `)

  await client.query(`
    ALTER TABLE live_sessions ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ NOT NULL DEFAULT now();
  `)
  await client.query(`
    ALTER TABLE live_sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS plans (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      price NUMERIC(14,2) NOT NULL DEFAULT 0,
      duration_days INTEGER NOT NULL DEFAULT 30,
      expiry_type TEXT NOT NULL DEFAULT 'duration',
      fixed_expiry_time TIME,
      is_active BOOLEAN NOT NULL DEFAULT true,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT plans_expiry_type_check CHECK (expiry_type IN ('duration', 'fixed'))
    );
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS plans_active_idx ON plans (is_active) WHERE deleted_at IS NULL;
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      order_id TEXT NOT NULL UNIQUE,
      external_id TEXT,
      plan_id INTEGER REFERENCES plans (id) ON DELETE SET NULL,
      phone TEXT NOT NULL DEFAULT '',
      amount NUMERIC(14,2) NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'TZS',
      status TEXT NOT NULL DEFAULT 'pending',
      raw_payload JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT transactions_status_check CHECK (status IN ('pending', 'completed', 'failed'))
    );
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS transactions_created_idx ON transactions (created_at DESC);
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS transactions_status_idx ON transactions (status);
  `)
  await client.query(`
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS device_id TEXT;
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS transactions_device_id_idx ON transactions (device_id)
    WHERE device_id IS NOT NULL AND trim(device_id) <> '';
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS device_subscriptions (
      device_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      expires_at TIMESTAMPTZ NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      transaction_id TEXT NOT NULL UNIQUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT device_subscriptions_status_check CHECK (status IN ('active', 'pending'))
    );
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS device_subscriptions_transaction_id_idx ON device_subscriptions (transaction_id);
  `)

  await client.query(`
    ALTER TABLE device_subscriptions ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ NOT NULL DEFAULT now();
  `)
  await client.query(`
    ALTER TABLE device_subscriptions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      phone TEXT PRIMARY KEY,
      plan_id INTEGER NOT NULL REFERENCES plans (id) ON DELETE SET NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  await client.query(`
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
  `)
  await client.query(`
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
  `)
  await client.query(`
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS user_id TEXT;
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS zenopay_settings (
      id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      environment TEXT NOT NULL DEFAULT 'test',
      api_endpoint TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL DEFAULT '',
      account_id TEXT NOT NULL DEFAULT '',
      webhook_url TEXT NOT NULL DEFAULT '',
      last_test_at TIMESTAMPTZ,
      last_test_ok BOOLEAN,
      last_test_message TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  await client.query(`
    INSERT INTO zenopay_settings (id) VALUES (1)
    ON CONFLICT (id) DO NOTHING;
  `)
}
