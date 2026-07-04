import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { ensureJsonFile, readJson, writeJsonAtomic } from '../lib/jsonFile.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { requireAdminPanelAccess } from '../middleware/adminPanelAuthGate.js'
import { resolvePublicAssetUrl } from '../lib/cdnAssets.js'
import { apiResponseCacheNamespace } from '../middleware/apiResponseCache.js'
import { UPLOADS_DIR, sendUploadError, uploadPaymentProviderLogo } from '../multerUpload.js'
import { afterImageMulter } from '../lib/imageMulterPipeline.js'

export const PAYMENT_PROVIDERS_FILE = 'payment-providers.json'
export const paymentProvidersRouter = Router()

paymentProvidersRouter.use('/settings/payment-providers', requireAdminPanelAccess)

const upload = uploadPaymentProviderLogo.single('logo')

function parseBool(v, defaultVal = true) {
  if (v === undefined || v === null || v === '') return defaultVal
  if (typeof v === 'boolean') return v
  const s = String(v).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(s)) return true
  if (['0', 'false', 'no', 'off'].includes(s)) return false
  return defaultVal
}

function normalizeLogoPath(v) {
  const s = String(v || '').trim()
  if (!s) return ''
  if (s.startsWith('/uploads/')) return s
  if (s.startsWith('http://') || s.startsWith('https://')) return s
  return ''
}

function logoUrlFromPath(logoPath, req) {
  const p = normalizeLogoPath(logoPath)
  if (!p) return ''
  return resolvePublicAssetUrl(p, req) || ''
}

function normalizeRow(row, req) {
  const r = row && typeof row === 'object' ? row : {}
  const logoPath = normalizeLogoPath(r.logoPath || r.logo || '')
  return {
    id: String(r.id || ''),
    name: String(r.name || '').trim(),
    active: Boolean(r.active),
    isActive: Boolean(r.active),
    logoPath,
    logo: logoPath,
    logoUrl: logoUrlFromPath(logoPath, req),
    createdAt: r.createdAt || null,
    updatedAt: r.updatedAt || null,
  }
}

async function ensurePaymentProvidersTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payment_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      active BOOLEAN NOT NULL DEFAULT true,
      logo_path TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
}

function dbRowToApiRow(row, req) {
  return normalizeRow(
    {
      id: row.id,
      name: row.name,
      active: row.active,
      logoPath: row.logo_path,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    },
    req,
  )
}

async function maybeBackfillProvidersFromFile(pool) {
  await ensureJsonFile(PAYMENT_PROVIDERS_FILE, '[]\n')
  const countRes = await pool.query(`SELECT COUNT(*)::int AS n FROM payment_providers`)
  if (Number(countRes.rows[0]?.n) > 0) return
  const rows = await readJson(PAYMENT_PROVIDERS_FILE, [])
  const list = Array.isArray(rows) ? rows : []
  for (const row of list) {
    const id = String(row?.id || '').trim()
    const name = String(row?.name || '').trim()
    const logoPath = normalizeLogoPath(row?.logoPath || row?.logo)
    if (!id || !name || !logoPath) continue
    await pool.query(
      `INSERT INTO payment_providers (id, name, active, logo_path, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz)
       ON CONFLICT (id) DO NOTHING`,
      [
        id,
        name,
        Boolean(row?.active),
        logoPath,
        row?.createdAt || new Date().toISOString(),
        row?.updatedAt || row?.createdAt || new Date().toISOString(),
      ],
    )
  }
}

async function withProviderStore({ fileFallback, dbAction }) {
  const pool = getPool()
  if (!pool) return fileFallback()
  await ensurePaymentProvidersTable(pool)
  await maybeBackfillProvidersFromFile(pool)
  return dbAction(pool)
}

async function listProviders(req) {
  return withProviderStore({
    fileFallback: async () => {
      const rows = await readJson(PAYMENT_PROVIDERS_FILE, [])
      const arr = Array.isArray(rows) ? rows : []
      return arr.map((r) => normalizeRow(r, req))
    },
    dbAction: async (pool) => {
      const { rows } = await pool.query(
        `SELECT id, name, active, logo_path, created_at, updated_at
         FROM payment_providers
         ORDER BY lower(name) ASC, created_at ASC`,
      )
      return rows.map((row) => dbRowToApiRow(row, req))
    },
  })
}

async function removeUploadIfAny(logoPath) {
  const p = normalizeLogoPath(logoPath)
  if (!p.startsWith('/uploads/')) return
  const base = path.basename(p)
  if (!base) return
  await fs.unlink(path.join(UPLOADS_DIR, base)).catch(() => {})
}

function runUpload(req, res, next) {
  upload(req, res, (err) => {
    void afterImageMulter(req, res, next, err)
  })
}

function maybeUpload(req, res, next) {
  if (req.is('multipart/form-data')) return runUpload(req, res, next)
  return next()
}

paymentProvidersRouter.get(
  '/payment-providers',
  apiResponseCacheNamespace('payment-providers'),
  async (req, res) => {
    try {
      const all = await listProviders(req)
      res.json(all.filter((p) => p.active))
    } catch (e) {
      console.error('[payment-providers] GET public failed:', e)
      res.status(500).json({ error: String(e.message || e) })
    }
  },
)

paymentProvidersRouter.get('/settings/payment-providers', async (req, res) => {
  try {
    const all = await listProviders(req)
    res.json(all)
  } catch (e) {
    console.error('[settings/payment-providers] GET failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

paymentProvidersRouter.post('/settings/payment-providers', maybeUpload, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const name = String(body.name || '').trim()
    if (!name) {
      if (req.file) await removeUploadIfAny(`/uploads/${req.file.filename}`)
      return res.status(400).json({ error: 'name is required' })
    }
    const logoPath = req.file ? `/uploads/${req.file.filename}` : normalizeLogoPath(body.logoPath || body.logo)
    if (!logoPath) {
      return res.status(400).json({ error: 'logo is required (PNG/JPG/WebP)' })
    }

    const row = await withProviderStore({
      fileFallback: async () => {
        const rows = await readJson(PAYMENT_PROVIDERS_FILE, [])
        const list = Array.isArray(rows) ? rows : []
        const now = new Date().toISOString()
        const next = {
          id: `pp_${Date.now()}_${randomBytes(4).toString('hex')}`,
          name,
          active: parseBool(body.active ?? body.isActive, true),
          logoPath,
          createdAt: now,
          updatedAt: now,
        }
        list.push(next)
        await writeJsonAtomic(PAYMENT_PROVIDERS_FILE, list)
        return next
      },
      dbAction: async (pool) => {
        const id = `pp_${Date.now()}_${randomBytes(4).toString('hex')}`
        const out = await pool.query(
          `INSERT INTO payment_providers (id, name, active, logo_path, created_at, updated_at)
           VALUES ($1, $2, $3, $4, now(), now())
           RETURNING id, name, active, logo_path, created_at, updated_at`,
          [id, name, parseBool(body.active ?? body.isActive, true), logoPath],
        )
        return dbRowToApiRow(out.rows[0], req)
      },
    })
    liveSyncBus.publish('config.payment_providers_changed', {
      topics: ['config'],
      action: 'created',
      synced_at: new Date().toISOString(),
    })
    res.status(201).json(row?.logoUrl ? row : normalizeRow(row, req))
  } catch (e) {
    console.error('[settings/payment-providers] POST failed:', e)
    if (req.file) await removeUploadIfAny(`/uploads/${req.file.filename}`)
    return sendUploadError(res, e, req, { status: 500 })
  }
})

paymentProvidersRouter.put('/settings/payment-providers/:id', maybeUpload, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim()
    if (!id) {
      if (req.file) await removeUploadIfAny(`/uploads/${req.file.filename}`)
      return res.status(400).json({ error: 'id is required' })
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const current = await withProviderStore({
      fileFallback: async () => {
        const rows = await readJson(PAYMENT_PROVIDERS_FILE, [])
        const list = Array.isArray(rows) ? rows : []
        const idx = list.findIndex((x) => String(x?.id || '') === id)
        return idx < 0 ? null : list[idx]
      },
      dbAction: async (pool) => {
        const out = await pool.query(
          `SELECT id, name, active, logo_path, created_at, updated_at
           FROM payment_providers
           WHERE id = $1`,
          [id],
        )
        return out.rows[0] ? dbRowToApiRow(out.rows[0], req) : null
      },
    })
    if (!current) {
      if (req.file) await removeUploadIfAny(`/uploads/${req.file.filename}`)
      return res.status(404).json({ error: 'Provider not found' })
    }
    const nextName = String(body.name || current.name || '').trim()
    if (!nextName) {
      if (req.file) await removeUploadIfAny(`/uploads/${req.file.filename}`)
      return res.status(400).json({ error: 'name is required' })
    }
    const incomingLogo = req.file
      ? `/uploads/${req.file.filename}`
      : normalizeLogoPath(body.logoPath || body.logo || current.logoPath || current.logo)
    if (!incomingLogo) {
      if (req.file) await removeUploadIfAny(`/uploads/${req.file.filename}`)
      return res.status(400).json({ error: 'logo is required (PNG/JPG/WebP)' })
    }

    const next = await withProviderStore({
      fileFallback: async () => {
        const rows = await readJson(PAYMENT_PROVIDERS_FILE, [])
        const list = Array.isArray(rows) ? rows : []
        const idx = list.findIndex((x) => String(x?.id || '') === id)
        if (idx < 0) return null
        const updated = {
          ...list[idx],
          name: nextName,
          active: parseBool(body.active ?? body.isActive, current.active !== false),
          logoPath: incomingLogo,
          updatedAt: new Date().toISOString(),
        }
        list[idx] = updated
        await writeJsonAtomic(PAYMENT_PROVIDERS_FILE, list)
        return updated
      },
      dbAction: async (pool) => {
        const out = await pool.query(
          `UPDATE payment_providers
           SET name = $2,
               active = $3,
               logo_path = $4,
               updated_at = now()
           WHERE id = $1
           RETURNING id, name, active, logo_path, created_at, updated_at`,
          [id, nextName, parseBool(body.active ?? body.isActive, current.active !== false), incomingLogo],
        )
        return out.rows[0] ? dbRowToApiRow(out.rows[0], req) : null
      },
    })
    if (!next) {
      if (req.file) await removeUploadIfAny(`/uploads/${req.file.filename}`)
      return res.status(404).json({ error: 'Provider not found' })
    }

    if (req.file) {
      const prevLogo = normalizeLogoPath(current.logoPath || current.logo)
      if (prevLogo && prevLogo !== incomingLogo) {
        await removeUploadIfAny(prevLogo)
      }
    }

    liveSyncBus.publish('config.payment_providers_changed', {
      topics: ['config'],
      action: 'updated',
      synced_at: new Date().toISOString(),
    })
    res.json(next?.logoUrl ? next : normalizeRow(next, req))
  } catch (e) {
    console.error('[settings/payment-providers] PUT failed:', e)
    if (req.file) await removeUploadIfAny(`/uploads/${req.file.filename}`)
    return sendUploadError(res, e, req, { status: 500 })
  }
})

paymentProvidersRouter.delete('/settings/payment-providers/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id is required' })
    const removed = await withProviderStore({
      fileFallback: async () => {
        const rows = await readJson(PAYMENT_PROVIDERS_FILE, [])
        const list = Array.isArray(rows) ? rows : []
        const idx = list.findIndex((x) => String(x?.id || '') === id)
        if (idx < 0) return null
        const [row] = list.splice(idx, 1)
        await writeJsonAtomic(PAYMENT_PROVIDERS_FILE, list)
        return row
      },
      dbAction: async (pool) => {
        const out = await pool.query(
          `DELETE FROM payment_providers
           WHERE id = $1
           RETURNING id, name, active, logo_path, created_at, updated_at`,
          [id],
        )
        return out.rows[0] ? dbRowToApiRow(out.rows[0], req) : null
      },
    })
    if (!removed) return res.status(404).json({ error: 'Provider not found' })
    await removeUploadIfAny(removed?.logoPath || removed?.logo)
    liveSyncBus.publish('config.payment_providers_changed', {
      topics: ['config'],
      action: 'deleted',
      synced_at: new Date().toISOString(),
    })
    res.status(204).send()
  } catch (e) {
    console.error('[settings/payment-providers] DELETE failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

export async function ensurePaymentProvidersFile() {
  await ensureJsonFile(PAYMENT_PROVIDERS_FILE, '[]\n')
}
