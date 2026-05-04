import { Router } from 'express'
import { planRowToApi } from '../billingNormalize.js'
import * as billing from '../billingStore.js'

export const plansRouter = Router()

function parsePlanBody(body) {
  const b = body || {}
  const expiryType = b.expiryType === 'fixed' || b.expiry_type === 'fixed' ? 'fixed' : 'duration'
  const fixedRaw = String(b.fixedExpiryTime ?? b.fixed_expiry_time ?? '00:00').trim()
  let fixed_expiry_time = null
  if (expiryType === 'fixed') {
    const m = /^(\d{1,2}):(\d{2})$/.exec(fixedRaw)
    if (m) {
      fixed_expiry_time = `${String(m[1]).padStart(2, '0')}:${String(m[2]).padStart(2, '0')}:00`
    }
  }
  return {
    name: String(b.name ?? '').trim(),
    price: Number.parseFloat(String(b.price ?? '0')),
    duration_days: Math.max(1, Math.floor(Number(b.durationDays ?? b.duration_days ?? 30))),
    expiry_type: expiryType,
    fixed_expiry_time,
    is_active: Boolean(b.isActive ?? b.is_active ?? true),
  }
}

plansRouter.get('/', async (_req, res) => {
  try {
    const rows = await billing.listPlansWithSubscriberCounts()
    res.json(rows.map(planRowToApi))
  } catch {
    res.status(500).json({ error: 'Failed to load plans' })
  }
})

plansRouter.post('/', async (req, res) => {
  try {
    const p = parsePlanBody(req.body)
    if (!p.name) return res.status(400).json({ error: 'name is required' })
    if (!Number.isFinite(p.price) || p.price < 0) {
      return res.status(400).json({ error: 'valid price is required' })
    }
    if (p.expiry_type === 'fixed' && !p.fixed_expiry_time) {
      return res.status(400).json({ error: 'fixedExpiryTime is required when expiryType is fixed' })
    }
    const row = await billing.insertPlan(p)
    res.status(201).json(planRowToApi({ ...row, active_subscriber_count: 0 }))
  } catch {
    res.status(500).json({ error: 'Failed to create plan' })
  }
})

plansRouter.put('/:id', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10)
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' })
    const existing = await billing.getPlanById(id)
    if (!existing) return res.status(404).json({ error: 'Plan not found' })
    const p = parsePlanBody(req.body)
    if (!p.name) return res.status(400).json({ error: 'name is required' })
    if (!Number.isFinite(p.price) || p.price < 0) {
      return res.status(400).json({ error: 'valid price is required' })
    }
    if (p.expiry_type === 'fixed' && !p.fixed_expiry_time) {
      return res.status(400).json({ error: 'fixedExpiryTime is required when expiryType is fixed' })
    }
    const row = await billing.updatePlan(id, p)
    if (!row) return res.status(404).json({ error: 'Plan not found' })
    const full = await billing.listPlansWithSubscriberCounts()
    const enriched = full.find((r) => Number(r.id) === id) || row
    res.json(planRowToApi(enriched))
  } catch {
    res.status(500).json({ error: 'Failed to update plan' })
  }
})

plansRouter.delete('/:id', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10)
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' })
    const ok = await billing.softDeletePlan(id)
    if (!ok) return res.status(404).json({ error: 'Plan not found' })
    res.status(204).send()
  } catch {
    res.status(500).json({ error: 'Failed to delete plan' })
  }
})
