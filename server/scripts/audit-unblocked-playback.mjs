/**
 * Production audit: admin-unblocked devices (smart_monitor / allowed) with playback denied.
 * Usage:
 *   node server/scripts/audit-unblocked-playback.mjs           # audit only
 *   node server/scripts/audit-unblocked-playback.mjs --reconcile
 */
const API = process.env.OSMANI_ADMIN_API || 'https://osmani-admin-api.onrender.com'
const TOKEN = process.env.ADMIN_TOKEN || '3030'
const RECONCILE = process.argv.includes('--reconcile')

async function j(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Token': TOKEN,
      ...(opts.headers || {}),
    },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${path} ${res.status}: ${body.error || JSON.stringify(body)}`)
  return body
}

async function main() {
  const health = await j('/api/health')
  console.log('API commit:', health.commit)

  if (RECONCILE) {
    const rec = await j('/api/security/reconcile-unblocked-playback', { method: 'POST', body: '{}' })
    console.log('\n=== RECONCILE ===')
    console.log(JSON.stringify(rec, null, 2))
  }

  const { audit } = await j('/api/security/playback-audit')
  console.log('\n=== PLAYBACK AUDIT ===')
  console.log('Total unblocked admin devices:', audit.total_unblocked_admin_devices)
  console.log('Total affected (playback denied):', audit.total_affected)
  console.log('Fixable (layer mismatch):', audit.total_fixable_affected)
  console.log('Subscription inactive only:', audit.total_subscription_inactive_only)
  console.log('By denial layer:', audit.by_denial_layer)
  console.log('Working devices:', audit.total_working)
  if (audit.reference_working_device) {
    console.log('\nReference working device:', audit.reference_working_device.device_id)
    console.log(JSON.stringify(audit.reference_working_device, null, 2))
  }
  if (audit.fixable_affected?.length) {
    console.log('\n--- Fixable affected devices ---')
    for (const d of audit.fixable_affected) {
      console.log(`${d.device_id}  layer=${d.denial_layer}`, d.layers)
    }
  }
  if (audit.affected?.length) {
    console.log('\n--- All affected ---')
    for (const d of audit.affected) {
      console.log(`${d.device_id}  ${d.admin_status}  layer=${d.denial_layer}`)
    }
  }

  if (audit.total_fixable_affected > 0 && !RECONCILE) {
    console.log('\nRun with --reconcile to apply system-wide repair.')
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
