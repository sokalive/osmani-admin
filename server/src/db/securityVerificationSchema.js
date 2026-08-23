/**
 * Idempotent schema for security verification hardening:
 * challenges, severe history, trust columns, anomalies.
 */

let migratePromise = null

async function queryExec(client, sql, params) {
  if (client && typeof client.query === 'function') return client.query(sql, params)
  throw new Error('securityVerificationSchema: query client required')
}

async function runSecurityVerificationSchemaMigration(client) {
  await queryExec(
    client,
    `CREATE TABLE IF NOT EXISTS security_verification_challenges (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      nonce TEXT NOT NULL UNIQUE,
      device_id TEXT NOT NULL,
      install_id TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      consumed_ip TEXT NOT NULL DEFAULT '',
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    )`,
  )

  await queryExec(
    client,
    `CREATE INDEX IF NOT EXISTS security_verification_challenges_device_idx
     ON security_verification_challenges (device_id, created_at DESC)`,
  )
  await queryExec(
    client,
    `CREATE INDEX IF NOT EXISTS security_verification_challenges_expires_idx
     ON security_verification_challenges (expires_at)
     WHERE consumed_at IS NULL`,
  )

  await queryExec(
    client,
    `CREATE TABLE IF NOT EXISTS security_severe_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      device_id TEXT NOT NULL,
      risk_type TEXT NOT NULL DEFAULT '',
      risk_score INT NOT NULL DEFAULT 0,
      signals JSONB NOT NULL DEFAULT '[]'::jsonb,
      flags JSONB NOT NULL DEFAULT '{}'::jsonb,
      source TEXT NOT NULL DEFAULT 'report',
      challenge_nonce TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    )`,
  )

  await queryExec(
    client,
    `CREATE INDEX IF NOT EXISTS security_severe_history_device_idx
     ON security_severe_history (device_id, created_at DESC)`,
  )

  await queryExec(
    client,
    `CREATE TABLE IF NOT EXISTS security_anomalies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      device_id TEXT NOT NULL DEFAULT '',
      anomaly_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'warning',
      detail TEXT NOT NULL DEFAULT '',
      ip TEXT NOT NULL DEFAULT '',
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
  )

  await queryExec(
    client,
    `CREATE INDEX IF NOT EXISTS security_anomalies_device_idx
     ON security_anomalies (device_id, created_at DESC)`,
  )
  await queryExec(
    client,
    `CREATE INDEX IF NOT EXISTS security_anomalies_type_idx
     ON security_anomalies (anomaly_type, created_at DESC)`,
  )

  const profileAlters = [
    `ALTER TABLE device_security_profiles ADD COLUMN IF NOT EXISTS trust_state TEXT NOT NULL DEFAULT 'pending_verification'`,
    `ALTER TABLE device_security_profiles ADD COLUMN IF NOT EXISTS last_trusted_verification_at TIMESTAMPTZ`,
    `ALTER TABLE device_security_profiles ADD COLUMN IF NOT EXISTS verification_fresh_until TIMESTAMPTZ`,
    `ALTER TABLE device_security_profiles ADD COLUMN IF NOT EXISTS highest_risk_score INT NOT NULL DEFAULT 0`,
    `ALTER TABLE device_security_profiles ADD COLUMN IF NOT EXISTS client_claimed_score_last INT`,
    `ALTER TABLE device_security_profiles ADD COLUMN IF NOT EXISTS server_calculated_score_last INT NOT NULL DEFAULT 0`,
    `ALTER TABLE device_security_profiles ADD COLUMN IF NOT EXISTS ever_severe BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE device_security_profiles ADD COLUMN IF NOT EXISTS ever_frida BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE device_security_profiles ADD COLUMN IF NOT EXISTS ever_tampered_apk BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE device_security_profiles ADD COLUMN IF NOT EXISTS ever_debugger BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE device_security_profiles ADD COLUMN IF NOT EXISTS ever_clone_detected BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE device_security_profiles ADD COLUMN IF NOT EXISTS ever_rooted BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE device_security_profiles ADD COLUMN IF NOT EXISTS ever_emulator BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE device_security_profiles ADD COLUMN IF NOT EXISTS first_severe_at TIMESTAMPTZ`,
    `ALTER TABLE device_security_profiles ADD COLUMN IF NOT EXISTS last_severe_at TIMESTAMPTZ`,
    `ALTER TABLE device_security_profiles ADD COLUMN IF NOT EXISTS trusted_clean_streak INT NOT NULL DEFAULT 0`,
    `ALTER TABLE device_security_profiles ADD COLUMN IF NOT EXISTS anomaly_count INT NOT NULL DEFAULT 0`,
    `ALTER TABLE device_security_profiles ADD COLUMN IF NOT EXISTS replay_attempt_count INT NOT NULL DEFAULT 0`,
    `ALTER TABLE device_security_profiles ADD COLUMN IF NOT EXISTS attestation_status TEXT NOT NULL DEFAULT 'none'`,
    `ALTER TABLE device_security_profiles ADD COLUMN IF NOT EXISTS attestation_verdict JSONB NOT NULL DEFAULT '{}'::jsonb`,
    `ALTER TABLE device_security_profiles ADD COLUMN IF NOT EXISTS last_attestation_at TIMESTAMPTZ`,
    `ALTER TABLE device_security_profiles ADD COLUMN IF NOT EXISTS playback_gate_reason TEXT NOT NULL DEFAULT ''`,
  ]

  for (const sql of profileAlters) {
    await queryExec(client, sql)
  }

  await queryExec(
    client,
    `CREATE INDEX IF NOT EXISTS device_security_profiles_trust_state_idx
     ON device_security_profiles (trust_state, verification_fresh_until DESC)`,
  )
  await queryExec(
    client,
    `CREATE INDEX IF NOT EXISTS device_security_profiles_ever_severe_idx
     ON device_security_profiles (ever_severe, last_severe_at DESC)
     WHERE ever_severe = true`,
  )

  // Backfill ever_* from current flags for existing rows (non-destructive)
  await queryExec(
    client,
    `UPDATE device_security_profiles SET
       ever_rooted = ever_rooted OR rooted,
       ever_emulator = ever_emulator OR emulator,
       ever_frida = ever_frida OR frida,
       ever_tampered_apk = ever_tampered_apk OR tampered_apk,
       ever_debugger = ever_debugger OR debugger,
       ever_clone_detected = ever_clone_detected OR clone_detected,
       ever_severe = ever_severe OR frida OR tampered_apk OR debugger OR clone_detected,
       highest_risk_score = GREATEST(highest_risk_score, COALESCE(risk_score, 0)),
       server_calculated_score_last = COALESCE(NULLIF(server_calculated_score_last, 0), risk_score)
     WHERE ever_severe = false
        OR highest_risk_score = 0
        OR ever_frida = false`,
  )
}

/**
 * @param {import('pg').Pool | import('pg').PoolClient} db
 */
export async function ensureSecurityVerificationSchema(db) {
  if (migratePromise) return migratePromise
  migratePromise = runSecurityVerificationSchemaMigration(db).catch((e) => {
    migratePromise = null
    throw e
  })
  return migratePromise
}
