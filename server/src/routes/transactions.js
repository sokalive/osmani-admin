import { Router } from 'express'
import { transactionRowToApi } from '../billingNormalize.js'
import * as billing from '../billingStore.js'

export const transactionsRouter = Router()

/** ?status=all|completed|pending|failed&from=ISO&to=ISO */
transactionsRouter.get('/', async (req, res) => {
  try {
    const q = req.query || {}
    const statusRaw = String(q.status ?? 'all').toLowerCase()
    const status = ['completed', 'pending', 'failed'].includes(statusRaw) ? statusRaw : 'all'
    const from = q.from ? String(q.from) : null
    const to = q.to ? String(q.to) : null
    const rows = await billing.listTransactions({ status, from, to })
    res.json(rows.map(transactionRowToApi))
  } catch {
    res.status(500).json({ error: 'Failed to load transactions' })
  }
})
