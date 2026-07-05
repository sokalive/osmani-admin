/**
 * Billing: plans, transactions, subscriptions, ZenoPay settings (single-row).
 */
import { ensureDeviceSecuritySchema } from './deviceSecuritySchema.js'
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

async function ensureActionConstraint(client, { tableName, constraintName, actions }) {
  const def = (await currentConstraintDefinition(client, tableName, constraintName)).toLowerCase()
  const wants = Array.from(new Set(actions.map((s) => String(s).toLowerCase())))
  const hasAll = def && wants.every((s) => def.includes(`'${s}'`))
  if (hasAll) {
    console.log(`[startup-migration] ${constraintName} already up-to-date`)
    return false
  }
  const actionSql = wants.map((s) => `'${s.replace(/'/g, "''")}'`).join(', ')
  await client.query(`ALTER TABLE ${tableName} DROP CONSTRAINT IF EXISTS ${constraintName};`)
  await client.query(
    `ALTER TABLE ${tableName}
     ADD CONSTRAINT ${constraintName}
     CHECK (action IN (${actionSql}));`,
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
      ('update_source', 'play'),
      ('update_apk_url', ''),
      ('update_apk_hash', ''),
      ('update_playstore_url', ''),
      ('update_version_code', '24'),
      ('update_version_name', '1.8.2'),
      ('update_package_name', 'com.burudanitv.app'),
      ('update_require_before_channel', 'false')
    ON CONFLICT (key) DO NOTHING;
  `)

  /** One-time bump legacy Play Store pins (17/1.7.0 → 24/1.8.2). Never downgrade admin saves. */
  const playStoreBump = await client.query(`
    UPDATE app_settings AS vc
    SET value = '24', updated_at = now()
    FROM app_settings AS vn
    WHERE vc.key = 'update_version_code'
      AND vn.key = 'update_version_name'
      AND vc.value = '17'
      AND vn.value = '1.7.0'
    RETURNING vc.key
  `)
  if (playStoreBump.rowCount > 0) {
    await client.query(`
      UPDATE app_settings
      SET value = '1.8.2', updated_at = now()
      WHERE key = 'update_version_name' AND value = '1.7.0'
    `)
    console.log('[startup-migration] Play Store app-update bumped 17/1.7.0 → 24/1.8.2')
  }

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
    INSERT INTO app_settings (key, value)
    VALUES
      ('trial_watch_enabled', 'false'),
      ('trial_watch_minutes', '30'),
      ('trial_preview_seconds', '120'),
      ('trial_preview_after_enabled', 'true')
    ON CONFLICT (key) DO NOTHING;
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS device_trial_entitlements (
      device_id TEXT PRIMARY KEY,
      fingerprint_hash TEXT NOT NULL DEFAULT '',
      install_instance_id TEXT NOT NULL DEFAULT '',
      trial_started_at TIMESTAMPTZ,
      trial_ended_at TIMESTAMPTZ,
      preview_after_started_at TIMESTAMPTZ,
      trial_seconds_consumed INTEGER NOT NULL DEFAULT 0,
      preview_seconds_consumed INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS device_trial_fingerprint_idx
    ON device_trial_entitlements (fingerprint_hash)
    WHERE fingerprint_hash <> '';
  `)
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS device_trial_fingerprint_consumed_uidx
    ON device_trial_entitlements (fingerprint_hash)
    WHERE fingerprint_hash <> '' AND trial_started_at IS NOT NULL;
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
    CREATE TABLE IF NOT EXISTS analytics_reset_challenges (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      challenge_token_hash TEXT NOT NULL UNIQUE,
      admin_user_id TEXT NOT NULL DEFAULT '',
      admin_email TEXT NOT NULL DEFAULT '',
      ip_address TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      device_label TEXT NOT NULL DEFAULT '',
      password_verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      otp_hash TEXT,
      otp_expires_at TIMESTAMPTZ,
      otp_used BOOLEAN NOT NULL DEFAULT false,
      otp_verify_attempts INT NOT NULL DEFAULT 0,
      otp_sent_count INT NOT NULL DEFAULT 0,
      last_otp_sent_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      last_otp_verify_ok BOOLEAN,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS analytics_reset_challenges_completed_idx
    ON analytics_reset_challenges (completed_at DESC)
    WHERE completed_at IS NOT NULL;
  `)
  await client.query(`
    ALTER TABLE analytics_reset_challenges
    ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'analytics_reset';
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS analytics_reset_challenges_purpose_completed_idx
    ON analytics_reset_challenges (purpose, completed_at DESC)
    WHERE completed_at IS NOT NULL;
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
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS recurrence_kind TEXT NOT NULL DEFAULT 'once';
  `)
  await client.query(`
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS recurrence_interval INTEGER;
  `)
  await client.query(`
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS recurrence_until TIMESTAMPTZ;
  `)
  await client.query(`
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS recurrence_anchor_at TIMESTAMPTZ;
  `)
  await client.query(`
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS recurrence_parent_id UUID;
  `)
  await client.query(`
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS is_recurrence_template BOOLEAN NOT NULL DEFAULT false;
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS notifications_recurrence_template_idx
    ON notifications (status, schedule_at)
    WHERE is_recurrence_template = true AND status = 'scheduled';
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
    CREATE INDEX IF NOT EXISTS device_subscriptions_status_expires_idx
    ON device_subscriptions (status, expires_at DESC);
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS transactions_device_pending_sub_idx
    ON transactions (device_id, created_at DESC)
    WHERE status = 'pending' AND plan_id IS NOT NULL;
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS transactions_device_completed_sub_idx
    ON transactions (device_id, created_at DESC)
    WHERE status = 'completed' AND plan_id IS NOT NULL;
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS transactions_phone_idx
    ON transactions (phone)
    WHERE phone IS NOT NULL AND trim(phone) <> '';
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS transactions_status_created_admin_idx
    ON transactions (status, created_at DESC)
    WHERE plan_id IS NOT NULL;
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS device_subscriptions_active_expires_idx
    ON device_subscriptions (expires_at ASC)
    WHERE status = 'active';
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

  await ensureDeviceSecuritySchema(client)

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
  await client.query(`
    ALTER TABLE sonicpesa_settings ADD COLUMN IF NOT EXISTS last_webhook_at TIMESTAMPTZ;
  `)
  await client.query(`
    ALTER TABLE sonicpesa_settings ADD COLUMN IF NOT EXISTS last_webhook_event TEXT NOT NULL DEFAULT '';
  `)
  await client.query(`
    ALTER TABLE sonicpesa_settings ADD COLUMN IF NOT EXISTS last_webhook_order_id TEXT NOT NULL DEFAULT '';
  `)
  await client.query(`
    ALTER TABLE sonicpesa_settings ADD COLUMN IF NOT EXISTS last_provider_webhook_at TIMESTAMPTZ;
  `)
  await client.query(`
    ALTER TABLE sonicpesa_settings ADD COLUMN IF NOT EXISTS last_engineering_probe_at TIMESTAMPTZ;
  `)
  await client.query(`
    ALTER TABLE sonicpesa_settings ADD COLUMN IF NOT EXISTS last_invalid_signature_at TIMESTAMPTZ;
  `)
  await client.query(`
    UPDATE sonicpesa_settings SET
      webhook_url = 'https://api.osmanitv.com/api/payments/sonicpesa/webhook',
      updated_at = now()
    WHERE id = 1
      AND (
        webhook_url ILIKE '%onrender.com%'
        OR webhook_url ILIKE '%osmani-admin-api%'
        OR trim(webhook_url) = ''
      );
  `)

  /** Aurax Pay (additive third gateway — ZenoPay + SonicPesa unchanged). */
  await client.query(`
    CREATE TABLE IF NOT EXISTS auraxpay_settings (
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
    INSERT INTO auraxpay_settings (id) VALUES (1)
    ON CONFLICT (id) DO NOTHING;
  `)
  await client.query(`
    ALTER TABLE auraxpay_settings ADD COLUMN IF NOT EXISTS last_webhook_at TIMESTAMPTZ;
  `)
  await client.query(`
    ALTER TABLE auraxpay_settings ADD COLUMN IF NOT EXISTS last_webhook_event TEXT NOT NULL DEFAULT '';
  `)
  await client.query(`
    ALTER TABLE auraxpay_settings ADD COLUMN IF NOT EXISTS last_webhook_order_id TEXT NOT NULL DEFAULT '';
  `)
  await client.query(`
    ALTER TABLE auraxpay_settings ADD COLUMN IF NOT EXISTS last_create_order_at TIMESTAMPTZ;
  `)
  await client.query(`
    ALTER TABLE auraxpay_settings ADD COLUMN IF NOT EXISTS last_create_order_url TEXT NOT NULL DEFAULT '';
  `)
  await client.query(`
    ALTER TABLE auraxpay_settings ADD COLUMN IF NOT EXISTS last_create_order_api_style TEXT NOT NULL DEFAULT '';
  `)
  await client.query(`
    ALTER TABLE auraxpay_settings ADD COLUMN IF NOT EXISTS last_create_order_http_status INT;
  `)
  await client.query(`
    ALTER TABLE auraxpay_settings ADD COLUMN IF NOT EXISTS last_create_order_response JSONB;
  `)
  await client.query(`
    ALTER TABLE auraxpay_settings ADD COLUMN IF NOT EXISTS webhook_secret TEXT NOT NULL DEFAULT '';
  `)

  /** Active checkout gateway for mobile app (zenopay | sonicpesa | auraxpay). */
  await client.query(`
    CREATE TABLE IF NOT EXISTS checkout_payment_settings (
      id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      payment_provider TEXT NOT NULL DEFAULT 'zenopay',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT checkout_payment_provider_check CHECK (payment_provider IN ('zenopay', 'sonicpesa'))
    );
  `)
  await client.query(`
    ALTER TABLE checkout_payment_settings DROP CONSTRAINT IF EXISTS checkout_payment_provider_check;
  `)
  await client.query(`
    ALTER TABLE checkout_payment_settings ADD CONSTRAINT checkout_payment_provider_check
      CHECK (payment_provider IN ('zenopay', 'sonicpesa', 'auraxpay'));
  `)
  await client.query(`
    INSERT INTO checkout_payment_settings (id, payment_provider) VALUES (1, 'zenopay')
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
    ALTER TABLE manual_subscription_grants ADD COLUMN IF NOT EXISTS plan_id INTEGER REFERENCES plans (id) ON DELETE SET NULL;
  `)
  await client.query(`
    ALTER TABLE manual_subscription_grants ADD COLUMN IF NOT EXISTS created_by TEXT;
  `)
  await client.query(`
    ALTER TABLE manual_subscription_grants ADD COLUMN IF NOT EXISTS manual_custom BOOLEAN NOT NULL DEFAULT false;
  `)
  await client.query(`
    ALTER TABLE manual_subscription_grants ADD COLUMN IF NOT EXISTS custom_expiry BOOLEAN NOT NULL DEFAULT false;
  `)
  await client.query(`
    ALTER TABLE manual_subscription_grants ADD COLUMN IF NOT EXISTS started_at_custom TIMESTAMPTZ;
  `)
  await client.query(`
    ALTER TABLE manual_subscription_grants ADD COLUMN IF NOT EXISTS expires_at_custom TIMESTAMPTZ;
  `)
  await client.query(`
    ALTER TABLE device_subscriptions ADD COLUMN IF NOT EXISTS manual_admin_blocked BOOLEAN NOT NULL DEFAULT false;
  `)
  await client.query(`
    ALTER TABLE device_subscriptions ADD COLUMN IF NOT EXISTS admin_revoked_at TIMESTAMPTZ;
  `)
  await client.query(`
    ALTER TABLE device_subscriptions ADD COLUMN IF NOT EXISTS admin_revoked_by TEXT;
  `)
  await client.query(`
    ALTER TABLE device_subscriptions ADD COLUMN IF NOT EXISTS admin_revocation_reason TEXT;
  `)
  await client.query(`
    ALTER TABLE device_subscriptions ADD COLUMN IF NOT EXISTS admin_revoked_transaction_id TEXT;
  `)
  await ensureStatusConstraint(client, {
    tableName: 'device_subscriptions',
    constraintName: 'device_subscriptions_status_check',
    statuses: ['active', 'pending', 'revoked'],
  })
  await client.query(`
    CREATE TABLE IF NOT EXISTS admin_subscription_revocation_actions (
      id SERIAL PRIMARY KEY,
      device_id TEXT NOT NULL,
      admin_identity TEXT NOT NULL DEFAULT 'admin',
      reason TEXT,
      revoked_transaction_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS admin_subscription_revocation_device_idx
    ON admin_subscription_revocation_actions (device_id, created_at DESC);
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

  /** Beem SMS gateway (additive — does not replace push notifications). */
  await client.query(`
    CREATE TABLE IF NOT EXISTS beem_settings (
      id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      enabled BOOLEAN NOT NULL DEFAULT false,
      api_key TEXT NOT NULL DEFAULT '',
      secret_key TEXT NOT NULL DEFAULT '',
      sender_name TEXT NOT NULL DEFAULT '',
      last_test_at TIMESTAMPTZ,
      last_test_ok BOOLEAN,
      last_test_message TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  await client.query(`
    INSERT INTO beem_settings (id) VALUES (1)
    ON CONFLICT (id) DO NOTHING;
  `)
  await client.query(`
    UPDATE beem_settings
    SET sender_name = 'OSMANITVMAX', updated_at = now()
    WHERE id = 1
      AND (
        trim(sender_name) = ''
        OR sender_name ILIKE '%osmani%tv%max%'
        OR sender_name ~ '[[:space:]]'
        OR length(regexp_replace(sender_name, '[^A-Za-z0-9]', '', 'g')) > 11
      )
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS sms_templates (
      template_key TEXT PRIMARY KEY,
      body TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      enabled BOOLEAN NOT NULL DEFAULT true,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  const defaultSmsTemplates = [
    [
      'subscription_activated',
      'Asante kwa kununua kifurushi cha Osmani TV. Kifurushi chako kimewezeshwa.',
      'Sent when a subscription is activated after payment or manual grant',
    ],
    [
      'subscription_expiring_soon',
      'Kifurushi chako kinaisha hivi karibuni. Tafadhali renew ili kuendelea kutumia huduma.',
      'Sent 3 days and 1 day before subscription expiry',
    ],
    [
      'subscription_expired',
      'Kifurushi chako kimekwisha. Lipia upya kuendelea kutumia Osmani TV.',
      'Sent when subscription expires',
    ],
  ]
  for (const [key, body, description] of defaultSmsTemplates) {
    await client.query(
      `INSERT INTO sms_templates (template_key, body, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (template_key) DO NOTHING`,
      [key, body, description],
    )
  }

  await client.query(`
    CREATE TABLE IF NOT EXISTS sms_send_log (
      id BIGSERIAL PRIMARY KEY,
      recipient TEXT NOT NULL DEFAULT '',
      device_id TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      template_key TEXT NOT NULL DEFAULT '',
      trigger_type TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      provider_response JSONB,
      provider_message_id TEXT NOT NULL DEFAULT '',
      idempotency_key TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS sms_send_log_created_at_idx
    ON sms_send_log (created_at DESC);
  `)
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS sms_send_log_idempotency_key_uidx
    ON sms_send_log (idempotency_key)
    WHERE idempotency_key <> '';
  `)
  await client.query(`
    ALTER TABLE sms_send_log ADD COLUMN IF NOT EXISTS sms_type TEXT NOT NULL DEFAULT '';
  `)
  await client.query(`
    ALTER TABLE sms_send_log ADD COLUMN IF NOT EXISTS subscription_id TEXT NOT NULL DEFAULT '';
  `)
  await client.query(`
    ALTER TABLE sms_send_log ADD COLUMN IF NOT EXISTS payment_id TEXT NOT NULL DEFAULT '';
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS device_phone_registry (
      device_id TEXT NOT NULL,
      install_instance_id TEXT NOT NULL DEFAULT '',
      phone_number_raw TEXT NOT NULL DEFAULT '',
      phone_number_normalized TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (device_id, install_instance_id)
    );
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS device_phone_registry_normalized_idx
    ON device_phone_registry (phone_number_normalized)
    WHERE phone_number_normalized <> '';
  `)

  const { ensureDeviceIntelligenceTables } = await import('./deviceIntelligenceTables.js')
  await ensureDeviceIntelligenceTables(client)

  const { ensureClientApiTelemetryTable } = await import('../lib/clientApiTelemetry.js')
  await ensureClientApiTelemetryTable(client)

  await client.query(`
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS normalized_phone TEXT;
  `)
  await client.query(`
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS mobile_network TEXT;
  `)
  await client.query(`
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS provider_label TEXT;
  `)
  await client.query(`
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS recovery_state TEXT;
  `)
  await client.query(`
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS recovery_approved_at TIMESTAMPTZ;
  `)
  await client.query(`
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS recovery_approved_by TEXT;
  `)
  await client.query(`
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS transactions_recovery_state_idx
    ON transactions (recovery_state) WHERE recovery_state IS NOT NULL;
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS transactions_provider_label_idx
    ON transactions (provider_label) WHERE provider_label IS NOT NULL;
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS admin_payment_recovery_actions (
      id SERIAL PRIMARY KEY,
      order_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('approve', 'reject', 'block', 'reconcile', 'recover_canonical', 'recover_manual')),
      idempotency_key TEXT NOT NULL UNIQUE,
      admin_identity TEXT NOT NULL DEFAULT 'admin',
      reason TEXT,
      original_txn_status TEXT,
      original_recovery_state TEXT,
      device_id TEXT,
      plan_id INTEGER REFERENCES plans (id) ON DELETE SET NULL,
      subscription_transaction_id TEXT,
      expires_at TIMESTAMPTZ,
      sms_sent BOOLEAN NOT NULL DEFAULT false,
      sms_result JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS admin_payment_recovery_order_idx
    ON admin_payment_recovery_actions (order_id, created_at DESC);
  `)
  await ensureActionConstraint(client, {
    tableName: 'admin_payment_recovery_actions',
    constraintName: 'admin_payment_recovery_actions_action_check',
    actions: ['approve', 'reject', 'block', 'reconcile', 'recover_canonical', 'recover_manual'],
  })

  await client.query(`
    CREATE TABLE IF NOT EXISTS subscription_requests (
      id SERIAL PRIMARY KEY,
      nonce UUID NOT NULL DEFAULT gen_random_uuid(),
      device_id TEXT NOT NULL,
      phone TEXT NOT NULL,
      normalized_phone TEXT,
      plan_id INTEGER REFERENCES plans (id) ON DELETE SET NULL,
      plan_name_snapshot TEXT,
      duration_days INTEGER,
      price_snapshot NUMERIC(14,2),
      status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'BLOCKED', 'CANCELLED')),
      app_version TEXT,
      runtime_version TEXT,
      request_metadata JSONB,
      admin_decision_by TEXT,
      admin_decision_at TIMESTAMPTZ,
      admin_reason TEXT,
      approved_plan_id INTEGER REFERENCES plans (id) ON DELETE SET NULL,
      resulting_grant_id INTEGER,
      resulting_order_id TEXT,
      subscription_expires_at TIMESTAMPTZ,
      sms_sent BOOLEAN NOT NULL DEFAULT false,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS subscription_requests_device_status_idx
    ON subscription_requests (device_id, status) WHERE deleted_at IS NULL;
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS subscription_requests_status_created_idx
    ON subscription_requests (status, created_at DESC) WHERE deleted_at IS NULL;
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS subscription_request_settings (
      id SMALLINT PRIMARY KEY DEFAULT 1,
      enabled BOOLEAN NOT NULL DEFAULT true,
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT subscription_request_settings_singleton CHECK (id = 1)
    );
  `)
  await client.query(`
    INSERT INTO subscription_request_settings (id, enabled) VALUES (1, true)
    ON CONFLICT (id) DO NOTHING;
  `)

  /** Durable SonicPesa webhook inbox — capture before ACK, idempotent processing + retry. */
  await client.query(`
    CREATE TABLE IF NOT EXISTS sonicpesa_webhook_inbox (
      id BIGSERIAL PRIMARY KEY,
      provider_event_id TEXT,
      provider_order_id TEXT NOT NULL DEFAULT '',
      merchant_order_id TEXT NOT NULL DEFAULT '',
      payload_hash TEXT NOT NULL,
      signature_verified BOOLEAN NOT NULL DEFAULT false,
      payload JSONB NOT NULL,
      processing_status TEXT NOT NULL DEFAULT 'RECEIVED',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error_redacted TEXT NOT NULL DEFAULT '',
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      processed_at TIMESTAMPTZ,
      next_retry_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT sonicpesa_webhook_inbox_status_check CHECK (
        processing_status IN (
          'RECEIVED', 'VERIFIED', 'PROCESSING', 'PROCESSED', 'RETRYABLE_ERROR', 'TERMINAL_REJECTED'
        )
      )
    );
  `)
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS sonicpesa_webhook_inbox_payload_hash_uidx
    ON sonicpesa_webhook_inbox (payload_hash);
  `)
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS sonicpesa_webhook_inbox_provider_event_uidx
    ON sonicpesa_webhook_inbox (provider_event_id)
    WHERE provider_event_id IS NOT NULL AND trim(provider_event_id) <> '';
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS sonicpesa_webhook_inbox_retry_idx
    ON sonicpesa_webhook_inbox (processing_status, next_retry_at)
    WHERE processing_status IN ('RECEIVED', 'VERIFIED', 'RETRYABLE_ERROR');
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS sonicpesa_webhook_inbox_received_idx
    ON sonicpesa_webhook_inbox (received_at DESC);
  `)
  await client.query(`
    ALTER TABLE sonicpesa_webhook_inbox ADD COLUMN IF NOT EXISTS inbox_source TEXT NOT NULL DEFAULT 'provider';
  `)

  /** Durable poll-fallback queue — survives PM2 restart when webhooks are absent. */
  await client.query(`
    CREATE TABLE IF NOT EXISTS sonicpesa_payment_reconciliation_queue (
      id BIGSERIAL PRIMARY KEY,
      order_id TEXT NOT NULL UNIQUE,
      device_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'PENDING',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error_redacted TEXT NOT NULL DEFAULT '',
      priority INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ,
      CONSTRAINT sonicpesa_payment_reconciliation_queue_status_check CHECK (
        status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'TERMINAL_FAILED', 'TERMINAL_ABANDONED')
      )
    );
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS sonicpesa_payment_reconciliation_queue_pending_idx
    ON sonicpesa_payment_reconciliation_queue (status, next_attempt_at, priority DESC)
    WHERE status = 'PENDING';
  `)
}
