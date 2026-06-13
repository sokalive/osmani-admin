/**
 * Idempotent device_security_profiles schema (shared by startup + runtime).
 * Safe to call repeatedly; uses in-process dedupe + constraint definition check.
 */

const ADMIN_STATUS_CONSTRAINT = 'device_security_profiles_admin_status_check'
const ADMIN_STATUS_VALUES = [
  'monitoring',
  'allowed',
  'whitelisted',
  'temp_block',
  'perm_block',
  'smart_monitor',
]

let migratePromise = null

async function queryExec(client, sql, params) {
  if (client && typeof client.query === 'function') return client.query(sql, params)
  throw new Error('deviceSecuritySchema: query client required')
}

async function currentConstraintDefinition(client, constraintName) {
  const { rows } = await queryExec(
    client,
    `SELECT pg_get_constraintdef(c.oid) AS def
     FROM pg_constraint c
     INNER JOIN pg_class t ON t.oid = c.conrelid
     INNER JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = current_schema()
       AND t.relname = 'device_security_profiles'
       AND c.conname = $1
     LIMIT 1`,
    [constraintName],
  )
  return String(rows[0]?.def || '')
}

async function ensureAdminStatusConstraint(client) {
  const def = (await currentConstraintDefinition(client, ADMIN_STATUS_CONSTRAINT)).toLowerCase()
  const wants = ADMIN_STATUS_VALUES.map((s) => `'${s}'`)
  const hasAll = def && wants.every((token) => def.includes(token))
  if (hasAll) return false

  await queryExec(
    client,
    `ALTER TABLE device_security_profiles DROP CONSTRAINT IF EXISTS ${ADMIN_STATUS_CONSTRAINT}`,
  )
  const statusSql = ADMIN_STATUS_VALUES.map((s) => `'${s.replace(/'/g, "''")}'`).join(', ')
  try {
    await queryExec(
      client,
      `ALTER TABLE device_security_profiles
       ADD CONSTRAINT ${ADMIN_STATUS_CONSTRAINT}
       CHECK (admin_status IN (${statusSql}))`,
    )
  } catch (e) {
    if (String(e?.code) === '42710') {
      const after = (await currentConstraintDefinition(client, ADMIN_STATUS_CONSTRAINT)).toLowerCase()
      if (wants.every((token) => after.includes(token))) return false
    }
    throw e
  }
  return true
}

async function runDeviceSecuritySchemaMigration(client) {
  await queryExec(
    client,
    `CREATE TABLE IF NOT EXISTS device_security_profiles (
      device_id TEXT PRIMARY KEY,
      phone_user TEXT NOT NULL DEFAULT '',
      app_version TEXT NOT NULL DEFAULT '',
      risk_type TEXT NOT NULL DEFAULT '',
      risk_score INT NOT NULL DEFAULT 0,
      rooted BOOLEAN NOT NULL DEFAULT false,
      emulator BOOLEAN NOT NULL DEFAULT false,
      clone_detected BOOLEAN NOT NULL DEFAULT false,
      debugger BOOLEAN NOT NULL DEFAULT false,
      frida BOOLEAN NOT NULL DEFAULT false,
      tampered_apk BOOLEAN NOT NULL DEFAULT false,
      signals JSONB NOT NULL DEFAULT '[]'::jsonb,
      security_level TEXT NOT NULL DEFAULT 'warning',
      admin_status TEXT NOT NULL DEFAULT 'monitoring',
      temp_block_until TIMESTAMPTZ,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      CONSTRAINT device_security_profiles_level_check
        CHECK (security_level IN ('warning', 'limited', 'blocked', 'critical'))
    )`,
  )

  await ensureAdminStatusConstraint(client)

  const columnAlters = [
    `ALTER TABLE device_security_profiles ADD COLUMN IF NOT EXISTS blocked BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE device_security_profiles ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ`,
    `ALTER TABLE device_security_profiles ADD COLUMN IF NOT EXISTS blocked_by TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE device_security_profiles ADD COLUMN IF NOT EXISTS unblocked_at TIMESTAMPTZ`,
    `ALTER TABLE device_security_profiles ADD COLUMN IF NOT EXISTS unblocked_by TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE device_security_profiles ADD COLUMN IF NOT EXISTS smart_monitor_enabled BOOLEAN NOT NULL DEFAULT false`,
  ]
  for (const sql of columnAlters) {
    await queryExec(client, sql)
  }

  await queryExec(
    client,
    `CREATE INDEX IF NOT EXISTS device_security_profiles_level_idx
     ON device_security_profiles (security_level, updated_at DESC)`,
  )
  await queryExec(
    client,
    `CREATE INDEX IF NOT EXISTS device_security_profiles_last_seen_idx
     ON device_security_profiles (last_seen_at DESC)`,
  )
}

/**
 * @param {import('pg').Pool | import('pg').PoolClient} db
 */
export async function ensureDeviceSecuritySchema(db) {
  if (migratePromise) return migratePromise
  migratePromise = runDeviceSecuritySchemaMigration(db).catch((e) => {
    migratePromise = null
    throw e
  })
  return migratePromise
}
