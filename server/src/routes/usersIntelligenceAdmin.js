import { Router } from 'express'
import { requireAdminPanelAccess } from '../middleware/adminPanelAuthGate.js'
import {
  backfillDeviceIntelligenceFromExisting,
  syncAllIntelligenceBlocksToPlayback,
  blockDeviceIntelligenceUser,
  getDeviceIntelligenceDetailBundle,
  getDeviceIntelligenceSummary,
  listDeviceIntelligenceRegistry,
  unblockDeviceIntelligenceUser,
} from '../lib/deviceIntelligenceStore.js'

export const usersIntelligenceAdminRouter = Router()
usersIntelligenceAdminRouter.use(requireAdminPanelAccess)

usersIntelligenceAdminRouter.get('/summary', async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private, must-revalidate')
    const summary = await getDeviceIntelligenceSummary()
    res.json({ ok: true, summary })
  } catch (e) {
    console.error('[users-intelligence summary]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

usersIntelligenceAdminRouter.get('/', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private, must-revalidate')
    const q = String(req.query.q ?? req.query.search ?? '').trim()
    const limit = Number(req.query.limit) || 100
    const offset = Number(req.query.offset) || 0
    const items = await listDeviceIntelligenceRegistry({ q, limit, offset })
    const summary = await getDeviceIntelligenceSummary()
    res.json({ ok: true, items, summary })
  } catch (e) {
    console.error('[users-intelligence list]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

usersIntelligenceAdminRouter.post('/backfill', async (_req, res) => {
  try {
    const result = await backfillDeviceIntelligenceFromExisting()
    const sync = await syncAllIntelligenceBlocksToPlayback()
    res.json({ ok: true, ...result, blockSync: sync })
  } catch (e) {
    console.error('[users-intelligence backfill]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

usersIntelligenceAdminRouter.post('/sync-blocks', async (_req, res) => {
  try {
    const sync = await syncAllIntelligenceBlocksToPlayback()
    res.json({ ok: true, ...sync })
  } catch (e) {
    console.error('[users-intelligence sync-blocks]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

usersIntelligenceAdminRouter.get('/:id', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private, must-revalidate')
    const detail = await getDeviceIntelligenceDetailBundle(req.params.id)
    if (!detail) return res.status(404).json({ ok: false, error: 'User not found' })
    res.json({ ok: true, ...detail })
  } catch (e) {
    console.error('[users-intelligence detail]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

usersIntelligenceAdminRouter.post('/:id/block', async (req, res) => {
  try {
    const reason = String(req.body?.reason ?? '').trim()
    if (!reason) return res.status(400).json({ ok: false, error: 'reason is required' })
    const adminEmail = String(req.adminPanelUser?.email ?? req.body?.adminEmail ?? 'admin')
    const registry = await blockDeviceIntelligenceUser(req.params.id, { reason, adminEmail })
    if (!registry) return res.status(404).json({ ok: false, error: 'User not found' })
    res.json({ ok: true, registry })
  } catch (e) {
    console.error('[users-intelligence block]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

usersIntelligenceAdminRouter.post('/:id/unblock', async (req, res) => {
  try {
    const adminEmail = String(req.adminPanelUser?.email ?? req.body?.adminEmail ?? 'admin')
    const note = String(req.body?.note ?? '').trim()
    const registry = await unblockDeviceIntelligenceUser(req.params.id, { adminEmail, note })
    if (!registry) return res.status(404).json({ ok: false, error: 'User not found' })
    res.json({ ok: true, registry })
  } catch (e) {
    console.error('[users-intelligence unblock]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})
