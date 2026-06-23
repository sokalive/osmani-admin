import { Router } from 'express'
import { requireAdminPanelAccess } from '../middleware/adminPanelAuthGate.js'
import { queryAppVersionMigrationStats } from '../lib/appVersionMigration.js'

export const appVersionMigrationAdminRouter = Router()
appVersionMigrationAdminRouter.use(requireAdminPanelAccess)

/** Legacy v16–v23 → v24 migration stats (shared DB; Render + VPS combined). */
appVersionMigrationAdminRouter.get('/stats', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private, must-revalidate')
    const report = await queryAppVersionMigrationStats({
      search: req.query.q ?? req.query.search ?? '',
      limit: req.query.limit,
      offset: req.query.offset,
    })
    if (!report.ok) {
      return res.status(503).json(report)
    }
    res.json(report)
  } catch (e) {
    console.error('[app-version-migration/stats]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})
