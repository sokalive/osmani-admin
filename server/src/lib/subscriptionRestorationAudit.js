import { getPool } from '../db/pool.js'
import {
  getDeviceSubscriptionAccessState,
  tryFinalizeActivationForDevice,
  hashDeviceFingerprint,
} from '../billingStore.js'
import {
  recoverSubscriptionToDevice,
  ensureSubscriptionLinkedForDevice,
  migrateSubscriptionFromSourceDevice,
} from './subscriptionRecovery.js'

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  return pool
}

/** Shadow device_ids that must not receive subscription again (post-migration / transfer). */
const SHADOW_DEVICE_EXCLUDE_SQL = `
  AND NOT EXISTS (
    SELECT 1 FROM device_subscriptions ds_rev
    WHERE ds_rev.device_id = %SHADOW%
      AND COALESCE(ds_rev.transaction_id, '') LIKE 'moved:%'
  )
  AND NOT EXISTS (
    SELECT 1 FROM device_transfers dt
    WHERE dt.status = 'completed' AND dt.source_device_id = %SHADOW%
  )`

function shadowExcludeFor(columnExpr) {
  return SHADOW_DEVICE_EXCLUDE_SQL.replaceAll('%SHADOW%', columnExpr)
}

/** Active subs in DB where a sibling device_id shares fingerprint via trial but has no active sub. */
export async function findMigrationShadowDevices(pool = requirePool()) {
  const { rows } = await pool.query(
    `SELECT DISTINCT
       dte_new.device_id AS shadow_device_id,
       ds_source.device_id AS source_device_id,
       dte_new.fingerprint_hash
     FROM device_subscriptions ds_source
     INNER JOIN device_trial_entitlements dte_src ON dte_src.device_id = ds_source.device_id
     INNER JOIN device_trial_entitlements dte_new
       ON dte_new.fingerprint_hash = dte_src.fingerprint_hash
      AND dte_new.fingerprint_hash <> ''
      AND dte_new.device_id <> ds_source.device_id
     LEFT JOIN device_subscriptions ds_new
       ON ds_new.device_id = dte_new.device_id
      AND ds_new.status = 'active'
      AND ds_new.expires_at > now()
     WHERE ds_source.status = 'active'
       AND ds_source.expires_at > now()
       AND ds_new.device_id IS NULL
       ${shadowExcludeFor('dte_new.device_id')}
     ORDER BY dte_new.device_id
     LIMIT 500`,
  )
  return rows
}

/** New VPS device_id shares payment phone with active sub on old device_id (no fingerprint required). */
export async function findMigrationShadowByPhone(pool = requirePool()) {
  const { rows } = await pool.query(
    `SELECT DISTINCT
       t_new.device_id::text AS shadow_device_id,
       ds_source.device_id::text AS source_device_id,
       trim(t_new.phone::text) AS phone
     FROM device_subscriptions ds_source
     INNER JOIN transactions t_source
       ON t_source.device_id = ds_source.device_id
      AND t_source.status = 'completed'
      AND trim(coalesce(t_source.phone::text, '')) <> ''
     INNER JOIN transactions t_new
       ON t_new.device_id <> ds_source.device_id
      AND trim(coalesce(t_new.phone::text, '')) <> ''
      AND (
        CASE
          WHEN regexp_replace(coalesce(t_new.phone::text, ''), '[^0-9]', '', 'g') ~ '^0[0-9]{9}$'
            THEN '255' || substr(regexp_replace(coalesce(t_new.phone::text, ''), '[^0-9]', '', 'g'), 2)
          WHEN regexp_replace(coalesce(t_new.phone::text, ''), '[^0-9]', '', 'g') ~ '^[67][0-9]{8}$'
            THEN '255' || regexp_replace(coalesce(t_new.phone::text, ''), '[^0-9]', '', 'g')
          ELSE regexp_replace(coalesce(t_new.phone::text, ''), '[^0-9]', '', 'g')
        END
      ) = (
        CASE
          WHEN regexp_replace(coalesce(t_source.phone::text, ''), '[^0-9]', '', 'g') ~ '^0[0-9]{9}$'
            THEN '255' || substr(regexp_replace(coalesce(t_source.phone::text, ''), '[^0-9]', '', 'g'), 2)
          WHEN regexp_replace(coalesce(t_source.phone::text, ''), '[^0-9]', '', 'g') ~ '^[67][0-9]{8}$'
            THEN '255' || regexp_replace(coalesce(t_source.phone::text, ''), '[^0-9]', '', 'g')
          ELSE regexp_replace(coalesce(t_source.phone::text, ''), '[^0-9]', '', 'g')
        END
      )
     LEFT JOIN device_subscriptions ds_new
       ON ds_new.device_id = t_new.device_id
      AND ds_new.status = 'active'
      AND ds_new.expires_at > now()
     WHERE ds_source.status = 'active'
       AND ds_source.expires_at > now()
       AND ds_new.device_id IS NULL
       ${shadowExcludeFor('t_new.device_id::text')}
     ORDER BY t_new.device_id
     LIMIT 500`,
  )
  return rows
}

/** New VPS device shares install_instance_id with active sub on old device (APK reinstall). */
export async function findMigrationShadowByInstallInstance(pool = requirePool()) {
  const { rows } = await pool.query(
    `SELECT DISTINCT
       ai_new.device_id::text AS shadow_device_id,
       ds_source.device_id::text AS source_device_id,
       ai_new.install_instance_id::text AS install_instance_id
     FROM app_installs ai_new
     INNER JOIN app_installs ai_src
       ON ai_src.install_instance_id = ai_new.install_instance_id
      AND trim(ai_src.install_instance_id) <> ''
      AND ai_src.device_id <> ai_new.device_id
     INNER JOIN device_subscriptions ds_source
       ON ds_source.device_id = ai_src.device_id
      AND ds_source.status = 'active'
      AND ds_source.expires_at > now()
     LEFT JOIN device_subscriptions ds_new
       ON ds_new.device_id = ai_new.device_id
      AND ds_new.status = 'active'
      AND ds_new.expires_at > now()
     WHERE ds_new.device_id IS NULL
       ${shadowExcludeFor('ai_new.device_id::text')}
     ORDER BY ai_new.device_id
     LIMIT 500`,
  )
  return rows
}

/** Inactive device shares intelligence phone/account with active sub on another device. */
export async function findMigrationShadowByIntelligencePhone(pool = requirePool()) {
  const { rows } = await pool.query(
    `SELECT DISTINCT
       ir_new.device_id::text AS shadow_device_id,
       ds_source.device_id::text AS source_device_id,
       trim(ir_new.phone_number) AS phone
     FROM device_intelligence_registry ir_new
     INNER JOIN device_intelligence_registry ir_src
       ON ir_src.device_id <> ir_new.device_id
      AND trim(coalesce(ir_src.phone_number, ir_new.phone_number, '')) <> ''
      AND (
        regexp_replace(coalesce(ir_new.phone_number, ''), '[^0-9]', '', 'g') =
        regexp_replace(coalesce(ir_src.phone_number, ''), '[^0-9]', '', 'g')
        OR regexp_replace(coalesce(ir_new.account_id, ''), '[^0-9]', '', 'g') =
        regexp_replace(coalesce(ir_src.account_id, ''), '[^0-9]', '', 'g')
      )
     INNER JOIN device_subscriptions ds_source
       ON ds_source.device_id = ir_src.device_id
      AND ds_source.status = 'active'
      AND ds_source.expires_at > now()
     LEFT JOIN device_subscriptions ds_new
       ON ds_new.device_id = ir_new.device_id
      AND ds_new.status = 'active'
      AND ds_new.expires_at > now()
     WHERE ds_new.device_id IS NULL
       AND trim(coalesce(ir_new.phone_number, ir_new.account_id, '')) <> ''
       ${shadowExcludeFor('ir_new.device_id::text')}
     ORDER BY ir_new.device_id
     LIMIT 500`,
  )
  return rows
}

/** Completed payments without a currently active subscription (excludes naturally expired subs). */
export async function findOrphanCompletedActivations(pool = requirePool()) {
  const { rows } = await pool.query(
    `SELECT DISTINCT t.device_id::text AS device_id, t.order_id
     FROM transactions t
     WHERE t.status = 'completed'
       AND COALESCE(t.device_id, '') <> ''
       AND NOT EXISTS (
         SELECT 1 FROM device_subscriptions ds
         WHERE ds.device_id = t.device_id
           AND ds.status = 'active'
           AND ds.expires_at > now()
       )
       AND NOT EXISTS (
         SELECT 1 FROM device_subscriptions ds
         WHERE ds.device_id = t.device_id
           AND ds.expires_at IS NOT NULL
           AND ds.expires_at <= now()
       )
       AND NOT EXISTS (
         SELECT 1 FROM device_subscriptions ds_mov
         WHERE ds_mov.device_id = t.device_id
           AND COALESCE(ds_mov.transaction_id, '') LIKE 'moved:%'
       )
       AND NOT EXISTS (
         SELECT 1 FROM device_transfers dt
         INNER JOIN device_subscriptions ds_tgt
           ON ds_tgt.device_id = dt.target_device_id
          AND ds_tgt.status = 'active'
          AND ds_tgt.expires_at > now()
         WHERE dt.status = 'completed'
           AND dt.source_device_id = t.device_id
       )
     ORDER BY t.device_id
     LIMIT 500`,
  )
  return rows
}

/** Completed payments where subscription row exists but is expired (ignored by orphan audit). */
export async function countExpiredSubscriptionOrphans(pool = requirePool()) {
  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT t.device_id)::int AS n
     FROM transactions t
     INNER JOIN device_subscriptions ds ON ds.device_id = t.device_id
     WHERE t.status = 'completed'
       AND COALESCE(t.device_id, '') <> ''
       AND ds.expires_at IS NOT NULL
       AND ds.expires_at <= now()
       AND NOT (ds.status = 'active' AND ds.expires_at > now())`,
  )
  return rows[0]?.n ?? 0
}

export async function countActiveSubscriptions(pool = requirePool()) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM device_subscriptions
     WHERE status = 'active' AND expires_at > now()`,
  )
  return rows[0]?.n ?? 0
}

export async function backfillSubscriptionFingerprintsFromTrial(pool = requirePool()) {
  const result = await pool.query(
    `UPDATE device_subscriptions ds
     SET fingerprint_hash = dte.fingerprint_hash, updated_at = now()
     FROM device_trial_entitlements dte
     WHERE ds.device_id = dte.device_id
       AND ds.status = 'active'
       AND ds.expires_at > now()
       AND (ds.fingerprint_hash IS NULL OR ds.fingerprint_hash = '')
       AND dte.fingerprint_hash IS NOT NULL
       AND dte.fingerprint_hash <> ''`,
  )
  return Number(result.rowCount) || 0
}

async function probeDeviceActive(deviceId, fingerprintHash = null) {
  const row = await getDeviceSubscriptionAccessState(deviceId, null)
  const activeByDevice = row?.active_now === true && row?.blocked_now !== true
  return { deviceId, activeByDevice, expiresAt: row?.expires_at ?? null, blocked: row?.blocked_now === true }
}

/**
 * @param {{ repair?: boolean }} opts
 */
export async function runSubscriptionRestorationAudit(opts = {}) {
  const repair = opts.repair === true
  const skipAutoLink = opts.skipAutoLink === true
  const pool = requirePool()
  const report = {
    ok: true,
    server_time: new Date().toISOString(),
    total_active_subscriptions: 0,
    affected_users_count: 0,
    migration_shadow_count: 0,
    migration_phone_shadow_count: 0,
    migration_install_shadow_count: 0,
    migration_intelligence_phone_shadow_count: 0,
    orphan_activation_count: 0,
    missing_fingerprint_count: 0,
    expired_users_ignored_count: 0,
    restored_users_count: 0,
    unresolved_users_count: 0,
    repairs: {
      fingerprints_backfilled: 0,
      migrations_recovered: 0,
      phone_migrations_recovered: 0,
      install_migrations_recovered: 0,
      intelligence_migrations_recovered: 0,
      auto_link_recovered: 0,
      activations_finalized: 0,
    },
    migration_pairs: [],
    unresolved: [],
    evidence: [],
  }

  report.total_active_subscriptions = await countActiveSubscriptions(pool)

  const missingFp = await pool.query(
    `SELECT COUNT(*)::int AS n FROM device_subscriptions
     WHERE status = 'active' AND expires_at > now()
       AND (fingerprint_hash IS NULL OR fingerprint_hash = '')`,
  )
  report.missing_fingerprint_count = missingFp.rows[0]?.n ?? 0

  const shadows = await findMigrationShadowDevices(pool)
  report.migration_shadow_count = shadows.length

  const phoneShadows = await findMigrationShadowByPhone(pool)
  report.migration_phone_shadow_count = phoneShadows.length

  const installShadows = await findMigrationShadowByInstallInstance(pool)
  report.migration_install_shadow_count = installShadows.length

  const intelPhoneShadows = await findMigrationShadowByIntelligencePhone(pool)
  report.migration_intelligence_phone_shadow_count = intelPhoneShadows.length

  const orphans = await findOrphanCompletedActivations(pool)
  report.orphan_activation_count = orphans.length
  report.expired_users_ignored_count = await countExpiredSubscriptionOrphans(pool)

  report.affected_users_count =
    shadows.length +
    phoneShadows.length +
    installShadows.length +
    intelPhoneShadows.length +
    orphans.length

  const pushPair = (shadowDeviceId, sourceDeviceId, matchReason, extra = {}) => {
    report.migration_pairs.push({
      old_active_device_id: String(sourceDeviceId || ''),
      new_vps_device_id: String(shadowDeviceId || ''),
      match_reason: matchReason,
      ...extra,
    })
  }

  for (const row of shadows) {
    pushPair(row.shadow_device_id, row.source_device_id, 'fingerprint_trial_shadow')
  }
  for (const row of phoneShadows) {
    pushPair(row.shadow_device_id, row.source_device_id, 'payment_phone_shadow', { phone: row.phone })
  }
  for (const row of installShadows) {
    pushPair(row.shadow_device_id, row.source_device_id, 'install_instance_shadow', {
      install_instance_id: row.install_instance_id,
    })
  }
  for (const row of intelPhoneShadows) {
    pushPair(row.shadow_device_id, row.source_device_id, 'intelligence_phone_shadow', { phone: row.phone })
  }

  if (repair) {
    report.repairs.fingerprints_backfilled = await backfillSubscriptionFingerprintsFromTrial(pool)

    for (const row of shadows) {
      const target = String(row.shadow_device_id || '').trim()
      const hash = String(row.fingerprint_hash || '').trim()
      if (!target || !hash) continue
      try {
        const rec = await recoverSubscriptionToDevice(target, hash, { reason: 'audit_repair' })
        if (rec.recovered) report.repairs.migrations_recovered += 1
      } catch (e) {
        report.unresolved.push({
          type: 'migration_shadow',
          device_id: target,
          error: String(e.message || e),
        })
      }
    }

    for (const row of phoneShadows) {
      const target = String(row.shadow_device_id || '').trim()
      const source = String(row.source_device_id || '').trim()
      if (!target) continue
      try {
        let linked = false
        let recoveredFrom = source
        if (source) {
          const mig = await migrateSubscriptionFromSourceDevice(target, source)
          if (mig.recovered) {
            report.repairs.phone_migrations_recovered += 1
            linked = true
            recoveredFrom = mig.recovered_from || source
          }
        }
        if (!linked) {
          const link = await ensureSubscriptionLinkedForDevice(target, { phone: row.phone })
          if (link.linked) {
            report.repairs.phone_migrations_recovered += 1
            linked = true
            recoveredFrom = link.recovered_from || source
          }
        }
        if (linked) pushPair(target, recoveredFrom, 'payment_phone_shadow')
      } catch (e) {
        report.unresolved.push({
          type: 'migration_phone_shadow',
          device_id: target,
          source_device_id: row.source_device_id,
          error: String(e.message || e),
        })
      }
    }

    for (const row of installShadows) {
      const target = String(row.shadow_device_id || '').trim()
      const source = String(row.source_device_id || '').trim()
      if (!target) continue
      try {
        let linked = false
        let recoveredFrom = source
        if (source) {
          const mig = await migrateSubscriptionFromSourceDevice(target, source)
          if (mig.recovered) {
            report.repairs.install_migrations_recovered += 1
            linked = true
            recoveredFrom = mig.recovered_from || source
          }
        }
        if (!linked) {
          const link = await ensureSubscriptionLinkedForDevice(target)
          if (link.linked) {
            report.repairs.install_migrations_recovered += 1
            linked = true
            recoveredFrom = link.recovered_from || source
          }
        }
        if (linked) {
          pushPair(target, recoveredFrom, 'install_instance_shadow', {
            install_instance_id: row.install_instance_id,
          })
        }
      } catch (e) {
        report.unresolved.push({
          type: 'migration_install_shadow',
          device_id: target,
          source_device_id: row.source_device_id,
          error: String(e.message || e),
        })
      }
    }

    for (const row of intelPhoneShadows) {
      const target = String(row.shadow_device_id || '').trim()
      if (!target) continue
      try {
        const link = await ensureSubscriptionLinkedForDevice(target, { phone: row.phone })
        if (link.linked) {
          report.repairs.intelligence_migrations_recovered += 1
          pushPair(target, link.recovered_from, link.method || 'intelligence_phone_shadow')
        }
      } catch (e) {
        report.unresolved.push({
          type: 'migration_intelligence_phone_shadow',
          device_id: target,
          source_device_id: row.source_device_id,
          error: String(e.message || e),
        })
      }
    }

    const { rows: inactiveRows } = skipAutoLink
      ? { rows: [] }
      : await pool.query(
      `SELECT ir.device_id::text AS device_id
       FROM device_intelligence_registry ir
       LEFT JOIN device_subscriptions ds
         ON ds.device_id = ir.device_id
        AND ds.status = 'active'
        AND ds.expires_at > now()
       WHERE ds.device_id IS NULL
       ORDER BY ir.last_seen_at DESC NULLS LAST
       LIMIT 300`,
    )
    for (const row of inactiveRows) {
      const target = String(row.device_id || '').trim()
      if (!target) continue
      try {
        const link = await ensureSubscriptionLinkedForDevice(target)
        if (link.linked) {
          report.repairs.auto_link_recovered += 1
          pushPair(target, link.recovered_from, link.method || 'auto_link')
        }
      } catch (e) {
        report.unresolved.push({
          type: 'auto_link',
          device_id: target,
          error: String(e.message || e),
        })
      }
    }

    for (const row of orphans) {
      const deviceId = String(row.device_id || '').trim()
      if (!deviceId) continue
      try {
        const fin = await tryFinalizeActivationForDevice(deviceId)
        if (fin.activated === true) report.repairs.activations_finalized += 1
      } catch (e) {
        report.unresolved.push({
          type: 'orphan_activation',
          device_id: deviceId,
          order_id: row.order_id,
          error: String(e.message || e),
        })
      }
    }
  }

  const shadowsAfter = repair ? await findMigrationShadowDevices(pool) : shadows
  const phoneShadowsAfter = repair ? await findMigrationShadowByPhone(pool) : phoneShadows
  const installShadowsAfter = repair ? await findMigrationShadowByInstallInstance(pool) : installShadows
  const intelPhoneShadowsAfter = repair ? await findMigrationShadowByIntelligencePhone(pool) : intelPhoneShadows
  const orphansAfter = repair ? await findOrphanCompletedActivations(pool) : orphans

  for (const row of shadowsAfter) {
    const probe = await probeDeviceActive(row.shadow_device_id)
    if (!probe.activeByDevice) {
      report.unresolved.push({
        type: 'migration_shadow_unresolved',
        shadow_device_id: row.shadow_device_id,
        source_device_id: row.source_device_id,
      })
    }
  }

  for (const row of phoneShadowsAfter) {
    const probe = await probeDeviceActive(row.shadow_device_id)
    if (!probe.activeByDevice) {
      report.unresolved.push({
        type: 'migration_phone_shadow_unresolved',
        shadow_device_id: row.shadow_device_id,
        source_device_id: row.source_device_id,
        phone: row.phone,
      })
    }
  }

  for (const row of installShadowsAfter) {
    const probe = await probeDeviceActive(row.shadow_device_id)
    if (!probe.activeByDevice) {
      report.unresolved.push({
        type: 'migration_install_shadow_unresolved',
        shadow_device_id: row.shadow_device_id,
        source_device_id: row.source_device_id,
        install_instance_id: row.install_instance_id,
      })
    }
  }

  for (const row of intelPhoneShadowsAfter) {
    const probe = await probeDeviceActive(row.shadow_device_id)
    if (!probe.activeByDevice) {
      report.unresolved.push({
        type: 'migration_intelligence_phone_shadow_unresolved',
        shadow_device_id: row.shadow_device_id,
        source_device_id: row.source_device_id,
        phone: row.phone,
      })
    }
  }

  for (const row of orphansAfter) {
    const probe = await probeDeviceActive(row.device_id)
    if (!probe.activeByDevice) {
      report.unresolved.push({
        type: 'orphan_activation_unresolved',
        device_id: row.device_id,
        order_id: row.order_id,
      })
    }
  }

  const uniqueUnresolved = new Map()
  for (const u of report.unresolved) {
    const key = u.device_id || u.shadow_device_id || JSON.stringify(u)
    uniqueUnresolved.set(key, u)
  }
  report.unresolved = [...uniqueUnresolved.values()]
  report.unresolved_users_count = report.unresolved.length
  if (repair) {
    report.restored_users_count =
      report.repairs.migrations_recovered +
      report.repairs.phone_migrations_recovered +
      report.repairs.install_migrations_recovered +
      report.repairs.intelligence_migrations_recovered +
      report.repairs.auto_link_recovered +
      report.repairs.activations_finalized
  } else {
    report.restored_users_count = Math.max(
      0,
      report.affected_users_count - report.unresolved_users_count,
    )
  }

  report.evidence.push({
    active_subscriptions: report.total_active_subscriptions,
    migration_shadow_remaining: shadowsAfter.length,
    migration_phone_shadow_remaining: phoneShadowsAfter.length,
    migration_install_shadow_remaining: installShadowsAfter.length,
    migration_intelligence_phone_shadow_remaining: intelPhoneShadowsAfter.length,
    orphan_activation_remaining: orphansAfter.length,
    expired_users_ignored: report.expired_users_ignored_count,
    missing_fingerprint_remaining: (
      await pool.query(
        `SELECT COUNT(*)::int AS n FROM device_subscriptions
         WHERE status = 'active' AND expires_at > now()
           AND (fingerprint_hash IS NULL OR fingerprint_hash = '')`,
      )
    ).rows[0]?.n,
  })

  report.ok = report.unresolved_users_count === 0
  return report
}

export function hashFingerprintForAudit(raw) {
  return hashDeviceFingerprint(raw)
}
