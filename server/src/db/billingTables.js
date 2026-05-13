/**
 * Billing: plans, transactions, subscriptions, ZenoPay settings (single-row).
 */
async function currentConstraintDefinition(client, tableName, constraintName) {
  const { rows } = await client.query(
    `SELECT pg_get_constraintdef(c.oid) AS def
     FROM pg_constraint c
     INNER JOIN pg_class t ON t.oid = c.conrelid
     INNER JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = current_schema()
       AND t.relname = $1
       AND c.conname = $2
     LIMIT 1`,
    [tableName, constraintName],
  )
  return String(rows[0]?.def || '')
}

async function ensureStatusConstraint(client, { tableName, constraintName, statuses }) {
  const def = (await currentConstraintDefinition(client, tableName, constraintName)).toLowerCase()
  const wants = Array.from(new Set(statuses.map((s) => String(s).toLowerCase())))
  const hasAll = def && wants.every((s) => def.includes(`'${s}'`))
  if (hasAll) {
    console.log(`[startup-migration] ${constraintName} already up-to-date`)
    return false
  }
  const statusSql = wants.map((s) => `'${s.replace(/'/g, "''")}'`).join(', ')
  await client.query(`ALTER TABLE ${tableName} DROP CONSTRAINT IF EXISTS ${constraintName};`)
  await client.query(
    `ALTER TABLE ${tableName}
     ADD CONSTRAINT ${constraintName}
     CHECK (status IN (${statusSql}));`,
  )
  console.log(`[startup-migration] ${constraintName} updated`)
  return true
}

export async function ensureBillingTables(client) {
  await client.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`)

  await client.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  await client.query(`
    INSERT INTO app_settings (key, value)
    VALUES
      ('update_soft', 'false'),
      ('update_force', 'false'),
      ('update_auto_download', 'false'),
      ('update_source', 'inapp'),
      ('update_apk_url', ''),
      ('update_apk_hash', ''),
      ('update_playstore_url', '')
    ON CONFLICT (key) DO NOTHING;
  `)

  await client.query(`
    INSERT INTO app_settings (key, value)
    VALUES
      ('transfer_mode', 'confirmation'),
      ('transfer_daily_limit', '5'),
      ('transfer_weekly_limit', '15'),
      ('transfer_cooldown_minutes', '60')
    ON CONFLICT (key) DO NOTHING;
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS app_installs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      device_id TEXT NOT NULL DEFAULT '',
      install_instance_id TEXT NOT NULL DEFAULT '',
      installed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  await client.query(`
    ALTER TABLE app_installs ADD COLUMN IF NOT EXISTS install_instance_id TEXT NOT NULL DEFAULT '';
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS app_installs_device_id_idx ON app_installs (device_id);
  `)
  await client.query(`
    DELETE FROM app_installs a
    USING app_installs b
    WHERE a.device_id = b.device_id
      AND COALESCE(a.install_instance_id, '') = COALESCE(b.install_instance_id, '')
      AND a.ctid < b.ctid;
  `)
  await client.query(`
    DROP INDEX IF EXISTS app_installs_device_id_unique_idx;
  `)
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS app_installs_device_install_instance_unique_idx
    ON app_installs (device_id, install_instance_id);
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
    DELETE FROM live_sessions a
    USING live_sessions b
    WHERE a.device_id = b.device_id
      AND a.ctid < b.ctid;
  `)
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS live_sessions_device_id_unique_idx ON live_sessions (device_id);
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
    CREATE TABLE IF NOT EXISTS notifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      kind TEXT NOT NULL DEFAULT 'admin',
      title TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      image TEXT NOT NULL DEFAULT '',
      target_audience TEXT NOT NULL DEFAULT 'all',
      target_type TEXT NOT NULL DEFAULT 'osmani://home',
      status TEXT NOT NULL DEFAULT 'draft',
      delivery_state TEXT NOT NULL DEFAULT 'pending',
      severity TEXT NOT NULL DEFAULT 'info',
      source_event TEXT NOT NULL DEFAULT '',
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      clicks INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT true,
      schedule_at TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      created_by TEXT NOT NULL DEFAULT 'system',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT notifications_kind_check CHECK (kind IN ('admin', 'system')),
      CONSTRAINT notifications_status_check CHECK (status IN ('draft', 'scheduled', 'sent', 'cancelled', 'archived')),
      CONSTRAINT notifications_delivery_state_check CHECK (delivery_state IN ('pending', 'sent', 'partial', 'failed')),
      CONSTRAINT notifications_severity_check CHECK (severity IN ('info', 'success', 'warning', 'critical'))
    );
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS notifications_created_at_idx ON notifications (created_at DESC);
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS notifications_status_idx ON notifications (status, schedule_at DESC);
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS notifications_runtime_idx
    ON notifications (is_active, status, target_audience, created_at DESC);
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS notifications_source_event_idx ON notifications (source_event, created_at DESC);
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
    ALTER TABLE device_subscriptions ADD COLUMN IF NOT EXISTS fingerprint_hash TEXT;
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS device_subscriptions_fingerprint_hash_idx
    ON device_subscriptions (fingerprint_hash)
    WHERE fingerprint_hash IS NOT NULL;
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS transfer_codes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      code TEXT NOT NULL UNIQUE,
      source_device_id TEXT NOT NULL,
      target_device_id TEXT,
      target_fingerprint_hash TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      created_by TEXT NOT NULL DEFAULT 'system',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT transfer_codes_status_check
        CHECK (status IN ('active', 'pending_confirmation', 'used', 'revoked', 'expired'))
    );
  `)
  await ensureStatusConstraint(client, {
    tableName: 'transfer_codes',
    constraintName: 'transfer_codes_status_check',
    statuses: ['active', 'pending_confirmation', 'used', 'revoked', 'expired'],
  })
  await client.query(`
    CREATE INDEX IF NOT EXISTS transfer_codes_source_device_idx ON transfer_codes (source_device_id);
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS transfer_codes_status_expiry_idx ON transfer_codes (status, expires_at DESC);
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS device_transfers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      code_id UUID REFERENCES transfer_codes (id) ON DELETE SET NULL,
      code TEXT,
      source_device_id TEXT NOT NULL,
      target_device_id TEXT NOT NULL,
      source_fingerprint_hash TEXT,
      target_fingerprint_hash TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      reason TEXT,
      requested_by TEXT NOT NULL DEFAULT 'device',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ,
      CONSTRAINT device_transfers_status_check
        CHECK (
          status IN (
            'requested',
            'awaiting_target_submission',
            'pending_confirmation',
            'approved',
            'completed',
            'rejected',
            'expired',
            'revoked'
          )
        )
    );
  `)
  await ensureStatusConstraint(client, {
    tableName: 'device_transfers',
    constraintName: 'device_transfers_status_check',
    statuses: [
      'requested',
      'awaiting_target_submission',
      'pending_confirmation',
      'approved',
      'completed',
      'rejected',
      'expired',
      'revoked',
    ],
  })
  await client.query(`
    CREATE INDEX IF NOT EXISTS device_transfers_source_idx ON device_transfers (source_device_id, created_at DESC);
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS device_transfers_target_idx ON device_transfers (target_device_id, created_at DESC);
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS security_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor TEXT NOT NULL DEFAULT '',
      event_type TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'completed',
      detail TEXT NOT NULL DEFAULT '',
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT security_events_status_check
        CHECK (status IN ('completed', 'failed', 'warning', 'blocked', 'pending'))
    );
  `)
  await ensureStatusConstraint(client, {
    tableName: 'security_events',
    constraintName: 'security_events_status_check',
    statuses: ['completed', 'failed', 'warning', 'blocked', 'pending'],
  })
  await client.query(`
    CREATE INDEX IF NOT EXISTS security_events_created_idx ON security_events (created_at DESC);
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS security_events_event_type_idx ON security_events (event_type);
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS admin_devices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      device_id TEXT NOT NULL UNIQUE,
      fingerprint_hash TEXT,
      is_blocked BOOLEAN NOT NULL DEFAULT false,
      block_reason TEXT,
      whitelisted BOOLEAN NOT NULL DEFAULT false,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS admin_devices_fingerprint_idx
    ON admin_devices (fingerprint_hash)
    WHERE fingerprint_hash IS NOT NULL;
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS admin_devices_blocked_idx
    ON admin_devices (is_blocked)
    WHERE is_blocked = true;
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS admin_otp_codes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      admin_id TEXT NOT NULL DEFAULT 'admin',
      code_hash TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'force_transfer',
      status TEXT NOT NULL DEFAULT 'active',
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT admin_otp_codes_status_check CHECK (status IN ('active', 'used', 'expired'))
    );
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS admin_otp_codes_admin_purpose_idx
    ON admin_otp_codes (admin_id, purpose, expires_at DESC);
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

  /** SonicPesa (separate from ZenoPay) — admin + checkout; optional env overrides in sonicpesaClient */
  await client.query(`
    CREATE TABLE IF NOT EXISTS sonicpesa_settings (
      id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      enabled BOOLEAN NOT NULL DEFAULT false,
      environment TEXT NOT NULL DEFAULT 'sandbox',
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
    INSERT INTO sonicpesa_settings (id) VALUES (1)
    ON CONFLICT (id) DO NOTHING;
  `)

  /** Admin manual subscription grants (gift UX + audit trail); device unlock uses device_subscriptions */
  await client.query(`
    CREATE TABLE IF NOT EXISTS manual_subscription_grants (
      id SERIAL PRIMARY KEY,
      device_id TEXT NOT NULL,
      duration_days INTEGER NOT NULL,
      nonce UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      acknowledged_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS manual_subscription_grants_device_pending_idx
    ON manual_subscription_grants (device_id, created_at ASC)
    WHERE acknowledged_at IS NULL;
  `)

  /** Hashed Manual Subscription admin PIN (first-time setup); env MANUAL_SUBSCRIPTION_ADMIN_PIN remains legacy fallback */
  await client.query(`
    CREATE TABLE IF NOT EXISTS manual_subscription_admin_pin (
      id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      pin_hash TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  await client.query(`
    INSERT INTO manual_subscription_admin_pin (id, pin_hash)
    VALUES (1, '')
    ON CONFLICT (id) DO NOTHING;
  `)

  await client.query(`
    ALTER TABLE manual_subscription_grants ADD COLUMN IF NOT EXISTS expires_at_snapshot TIMESTAMPTZ;
  `)
  await client.query(`
    ALTER TABLE manual_subscription_grants ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  `)
  await client.query(`
    ALTER TABLE device_subscriptions ADD COLUMN IF NOT EXISTS manual_admin_blocked BOOLEAN NOT NULL DEFAULT false;
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS offer_codes (
      id SERIAL PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      duration_days INTEGER NOT NULL,
      created_by TEXT NOT NULL DEFAULT 'admin',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      used_by_device TEXT,
      used_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL,
      blocked BOOLEAN NOT NULL DEFAULT false,
      deleted_at TIMESTAMPTZ,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      lock_until TIMESTAMPTZ
    );
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS offer_codes_created_at_idx ON offer_codes (created_at DESC);
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS offer_codes_used_at_idx ON offer_codes (used_at DESC)
    WHERE used_at IS NOT NULL;
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS offer_code_device_attempts (
      device_id TEXT PRIMARY KEY,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      lock_until TIMESTAMPTZ,
      lock_tier INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)

  /**
   * Osmani admin panel login (separate from subscriber admin_devices + transfer admin_otp_codes).
   */
  await client.query(`
    CREATE TABLE IF NOT EXISTS admin_panel_users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS admin_panel_trusted_devices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      admin_user_id UUID NOT NULL REFERENCES admin_panel_users (id) ON DELETE CASCADE,
      device_fingerprint_hash TEXT NOT NULL,
      device_name TEXT NOT NULL DEFAULT '',
      browser TEXT NOT NULL DEFAULT '',
      ip_address TEXT NOT NULL DEFAULT '',
      trusted BOOLEAN NOT NULL DEFAULT true,
      blocked BOOLEAN NOT NULL DEFAULT false,
      force_otp_next BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (admin_user_id, device_fingerprint_hash)
    );
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS admin_panel_trusted_devices_user_idx
    ON admin_panel_trusted_devices (admin_user_id);
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS admin_panel_trusted_devices_fp_idx
    ON admin_panel_trusted_devices (device_fingerprint_hash);
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS admin_panel_login_otps (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      admin_user_id UUID NOT NULL REFERENCES admin_panel_users (id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      device_fingerprint_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS admin_panel_login_otps_user_created_idx
    ON admin_panel_login_otps (admin_user_id, created_at DESC);
  `)
}
