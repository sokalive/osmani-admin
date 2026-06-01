/**
 * Production notification scheduler audit (read-only).
 * Usage: node scripts/verify-production-notification-scheduler.mjs [notification_id]
 */
const API = (process.env.API_BASE || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const TOKEN = process.env.ADMIN_LEGACY_TOKEN || process.env.X_ADMIN_TOKEN || '3030'
const targetId = process.argv[2] || ''

async function main() {
  const health = await fetch(`${API}/api/health`).then((r) => r.json())
  const now = new Date(health.time || Date.now())
  const rows = await fetch(`${API}/api/notifications`, {
    headers: { 'X-Admin-Token': TOKEN },
  }).then((r) => r.json())

  const scheduled = rows.filter((n) => n.status === 'scheduled')
  console.log(
    JSON.stringify(
      {
        server_commit: health.commit,
        server_time_utc: now.toISOString(),
        scheduled_count: scheduled.length,
        flush_runs_on_list: true,
        poller_interval_ms: 30_000,
      },
      null,
      2,
    ),
  )

  for (const n of scheduled) {
    if (targetId && n.id !== targetId) continue
    const due = n.scheduleAt && new Date(n.scheduleAt).getTime() <= now.getTime()
    const eat = n.scheduleAt
      ? new Date(n.scheduleAt).toLocaleString('en-GB', { timeZone: 'Africa/Dar_es_Salaam' })
      : null
    console.log(
      JSON.stringify(
        {
          id: n.id,
          title: n.title,
          status: n.status,
          schedule_at_utc: n.scheduleAt,
          schedule_eat: eat,
          due_now: due,
          recurrence_kind: n.recurrenceKind,
          is_recurrence_template: n.isRecurrenceTemplate,
          delivery_state: n.deliveryState,
          recurrence_anchor_at: n.recurrenceAnchorAt,
          created_at: n.createdAt,
          updated_at: n.updatedAt,
        },
        null,
        2,
      ),
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
