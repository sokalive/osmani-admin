import { closePool, getPool } from './pool.js'

async function main() {
  const pool = getPool()
  if (!pool) {
    throw new Error('DATABASE_URL is required to run transfer status migration')
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`
      ALTER TABLE transfer_codes
      DROP CONSTRAINT IF EXISTS transfer_codes_status_check;
    `)
    await client.query(`
      ALTER TABLE transfer_codes
      ADD CONSTRAINT transfer_codes_status_check
      CHECK (status IN ('active', 'pending_confirmation', 'used', 'revoked', 'expired'));
    `)
    await client.query(`
      ALTER TABLE device_transfers
      DROP CONSTRAINT IF EXISTS device_transfers_status_check;
    `)
    await client.query(`
      ALTER TABLE device_transfers
      ADD CONSTRAINT device_transfers_status_check
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
      );
    `)
    await client.query('COMMIT')
    console.log('[migration] transfer status checks updated successfully')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
    await closePool()
  }
}

main().catch((e) => {
  console.error('[migration] failed:', e)
  process.exit(1)
})
