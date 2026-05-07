import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { Router } from 'express'
import { ensureJsonFile, readJson, writeJsonAtomic } from '../lib/jsonFile.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { UPLOADS_DIR, uploadPaymentProviderLogo } from '../multerUpload.js'

export const PAYMENT_PROVIDERS_FILE = 'payment-providers.json'
export const paymentProvidersRouter = Router()

const upload = uploadPaymentProviderLogo.single('logo')

function parseBool(v, defaultVal = true) {
  if (v === undefined || v === null || v === '') return defaultVal
  if (typeof v === 'boolean') return v
  const s = String(v).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(s)) return true
  if (['0', 'false', 'no', 'off'].includes(s)) return false
  return defaultVal
}

function baseUrlFromReq(req) {
  const fromEnv = String(process.env.BASE_URL || '').trim()
  if (fromEnv) return fromEnv.replace(/\/$/, '')
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0]
  const host = String(req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0]
  return `${proto}://${host}`.replace(/\/$/, '')
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
  if (p.startsWith('http://') || p.startsWith('https://')) return p
  return `${baseUrlFromReq(req)}${p}`
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

async function listProviders(req) {
  const rows = await readJson(PAYMENT_PROVIDERS_FILE, [])
  const arr = Array.isArray(rows) ? rows : []
  return arr.map((r) => normalizeRow(r, req))
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
    if (err) {
      res.status(400).json({ error: String(err.message || err) })
      return
    }
    next()
  })
}

function maybeUpload(req, res, next) {
  if (req.is('multipart/form-data')) return runUpload(req, res, next)
  return next()
}

paymentProvidersRouter.get('/payment-providers', async (req, res) => {
  try {
    const all = await listProviders(req)
    res.json(all.filter((p) => p.active))
  } catch (e) {
    console.error('[payment-providers] GET public failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

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

    const rows = await readJson(PAYMENT_PROVIDERS_FILE, [])
    const list = Array.isArray(rows) ? rows : []
    const now = new Date().toISOString()
    const row = {
      id: `pp_${Date.now()}_${randomBytes(4).toString('hex')}`,
      name,
      active: parseBool(body.active ?? body.isActive, true),
      logoPath,
      createdAt: now,
      updatedAt: now,
    }
    list.push(row)
    await writeJsonAtomic(PAYMENT_PROVIDERS_FILE, list)
    liveSyncBus.publish('config.payment_providers_changed', { topics: ['config'], action: 'created' })
    res.status(201).json(normalizeRow(row, req))
  } catch (e) {
    console.error('[settings/payment-providers] POST failed:', e)
    if (req.file) await removeUploadIfAny(`/uploads/${req.file.filename}`)
    res.status(500).json({ error: String(e.message || e) })
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
    const rows = await readJson(PAYMENT_PROVIDERS_FILE, [])
    const list = Array.isArray(rows) ? rows : []
    const idx = list.findIndex((x) => String(x?.id || '') === id)
    if (idx < 0) {
      if (req.file) await removeUploadIfAny(`/uploads/${req.file.filename}`)
      return res.status(404).json({ error: 'Provider not found' })
    }
    const current = list[idx]
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

    const next = {
      ...current,
      name: nextName,
      active: parseBool(body.active ?? body.isActive, current.active !== false),
      logoPath: incomingLogo,
      updatedAt: new Date().toISOString(),
    }
    list[idx] = next
    await writeJsonAtomic(PAYMENT_PROVIDERS_FILE, list)

    if (req.file) {
      const prevLogo = normalizeLogoPath(current.logoPath || current.logo)
      if (prevLogo && prevLogo !== incomingLogo) {
        await removeUploadIfAny(prevLogo)
      }
    }

    liveSyncBus.publish('config.payment_providers_changed', { topics: ['config'], action: 'updated' })
    res.json(normalizeRow(next, req))
  } catch (e) {
    console.error('[settings/payment-providers] PUT failed:', e)
    if (req.file) await removeUploadIfAny(`/uploads/${req.file.filename}`)
    res.status(500).json({ error: String(e.message || e) })
  }
})

paymentProvidersRouter.delete('/settings/payment-providers/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id is required' })
    const rows = await readJson(PAYMENT_PROVIDERS_FILE, [])
    const list = Array.isArray(rows) ? rows : []
    const idx = list.findIndex((x) => String(x?.id || '') === id)
    if (idx < 0) return res.status(404).json({ error: 'Provider not found' })
    const [removed] = list.splice(idx, 1)
    await writeJsonAtomic(PAYMENT_PROVIDERS_FILE, list)
    await removeUploadIfAny(removed?.logoPath || removed?.logo)
    liveSyncBus.publish('config.payment_providers_changed', { topics: ['config'], action: 'deleted' })
    res.status(204).send()
  } catch (e) {
    console.error('[settings/payment-providers] DELETE failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

export async function ensurePaymentProvidersFile() {
  await ensureJsonFile(PAYMENT_PROVIDERS_FILE, '[]\n')
}
