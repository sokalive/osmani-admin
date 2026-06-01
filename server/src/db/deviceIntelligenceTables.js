/**
 * Users Intelligence — device registry (additive; does not alter billing/security tables).
 */

export async function ensureDeviceIntelligenceTables(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS device_intelligence_registry (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id TEXT NOT NULL DEFAULT '',
      user_id TEXT NOT NULL DEFAULT '',
      device_id TEXT NOT NULL,
      device_fingerprint TEXT NOT NULL DEFAULT '',
      android_id TEXT NOT NULL DEFAULT '',
      device_model TEXT NOT NULL DEFAULT '',
      device_brand TEXT NOT NULL DEFAULT '',
      os_version TEXT NOT NULL DEFAULT '',
      app_version TEXT NOT NULL DEFAULT '',
      phone_number TEXT NOT NULL DEFAULT '',
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      status TEXT NOT NULL DEFAULT 'active',
      block_reason TEXT NOT NULL DEFAULT '',
      blocked_by TEXT NOT NULL DEFAULT '',
      blocked_at TIMESTAMPTZ,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT device_intelligence_registry_status_check
        CHECK (status IN ('active', 'blocked', 'inactive'))
    );
  `)

  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS device_intelligence_registry_device_id_uidx
    ON device_intelligence_registry (device_id);
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS device_intelligence_registry_account_id_idx
    ON device_intelligence_registry (account_id);
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS device_intelligence_registry_user_id_idx
    ON device_intelligence_registry (user_id);
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS device_intelligence_registry_fingerprint_idx
    ON device_intelligence_registry (device_fingerprint)
    WHERE device_fingerprint <> '';
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS device_intelligence_registry_phone_idx
    ON device_intelligence_registry (phone_number)
    WHERE phone_number <> '';
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS device_intelligence_registry_status_idx
    ON device_intelligence_registry (status, last_seen_at DESC);
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS device_intelligence_login_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      registry_id UUID REFERENCES device_intelligence_registry (id) ON DELETE CASCADE,
      device_id TEXT NOT NULL DEFAULT '',
      account_id TEXT NOT NULL DEFAULT '',
      event_type TEXT NOT NULL DEFAULT 'register',
      ip_address TEXT NOT NULL DEFAULT '',
      app_version TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT device_intelligence_login_event_check
        CHECK (event_type IN ('register', 'login', 'heartbeat', 'blocked_attempt'))
    );
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS device_intelligence_login_log_device_idx
    ON device_intelligence_login_log (device_id, created_at DESC);
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS device_intelligence_device_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      registry_id UUID REFERENCES device_intelligence_registry (id) ON DELETE CASCADE,
      device_id TEXT NOT NULL DEFAULT '',
      device_fingerprint TEXT NOT NULL DEFAULT '',
      android_id TEXT NOT NULL DEFAULT '',
      device_model TEXT NOT NULL DEFAULT '',
      device_brand TEXT NOT NULL DEFAULT '',
      os_version TEXT NOT NULL DEFAULT '',
      app_version TEXT NOT NULL DEFAULT '',
      change_summary TEXT NOT NULL DEFAULT '',
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS device_intelligence_device_history_registry_idx
    ON device_intelligence_device_history (registry_id, recorded_at DESC);
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS device_intelligence_admin_actions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      registry_id UUID REFERENCES device_intelligence_registry (id) ON DELETE SET NULL,
      device_id TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      admin_email TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT device_intelligence_admin_action_check
        CHECK (action IN ('block', 'unblock', 'note'))
    );
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS device_intelligence_admin_actions_device_idx
    ON device_intelligence_admin_actions (device_id, created_at DESC);
  `)
}
