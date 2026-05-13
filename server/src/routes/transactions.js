import { Router } from 'express'
import * as billing from '../billingStore.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { requireAdminPanelAccess } from '../middleware/adminPanelAuthGate.js'

export const transactionsRouter = Router()

transactionsRouter.use(requireAdminPanelAccess)

/** ?status=all|completed|pending|failed&from=ISO&to=ISO */
transactionsRouter.get('/', async (req, res) => {
  try {
    const q = req.query || {}
    const statusRaw = String(q.status ?? 'all').toLowerCase()
    const status = ['completed', 'pending', 'failed'].includes(statusRaw) ? statusRaw : 'all'
    const from = q.from ? String(q.from) : null
    const to = q.to ? String(q.to) : null
    const rows = await billing.listTransactionsAdmin({ status, from, to })
    res.json(
      rows.map((r) => ({
        order_id: String(r.order_id ?? ''),
        amount: Number(r.amount) || 0,
        status: String(r.status ?? 'pending'),
        phone: String(r.phone ?? ''),
        device_id: r.device_id != null ? String(r.device_id) : '',
        created_at:
          r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at ?? ''),
      })),
    )
  } catch (e) {
    console.error('[transactions] GET / failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

transactionsRouter.delete('/bulk', async (req, res) => {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const ids = Array.isArray(b.ids) ? b.ids : []
    const out = await billing.deleteTransactionsBulkByOrderIds(ids)
    if (out.deleted > 0) {
      liveSyncBus.publish('analytics.transaction_updated', {
        topics: ['analytics'],
        action: 'deleted',
        deleted: out.deleted,
        synced_at: new Date().toISOString(),
      })
    }
    res.json({ ok: true, deleted: out.deleted })
  } catch (e) {
    console.error('[transactions] DELETE /bulk failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})
