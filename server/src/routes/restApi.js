import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { channelsRouter } from './channels.js'
import { ensureJsonFile, readJson, writeJsonAtomic } from '../lib/jsonFile.js'

const FILES = {
  banners: 'banners.json',
  plans: 'plans.json',
  users: 'users.json',
  transactions: 'transactions.json',
  notifications: 'notifications.json',
  transferCodes: 'transfer-codes.json',
  zenopay: 'zenopay.json',
  whatsapp: 'whatsapp.json',
  appUpdate: 'app-update.json',
  popup: 'popup.json',
  deviceControl: 'device-control.json',
  securitySuite: 'security-suite.json',
  securityLogs: 'security-logs.json',
  dashboard: 'dashboard.json',
}

const defaultZenopay = () => ({
  environment: 'test',
  apiEndpoint: 'https://sandbox.zenopay.example/v1',
  apiKey: '',
  webhookUrl: 'https://admin.osmani.tv/webhooks/zenopay',
  lastTestAt: null,
  lastTestOk: null,
  lastTestMessage: '',
})

const defaultWhatsapp = () => ({ link: 'https://wa.me/255712345678', message: '' })

const defaultAppUpdate = () => ({
  softUpdate: true,
  forceUpdate: false,
  autoDownload: true,
  source: 'inapp',
  apkUrl: 'https://cdn.osmani.tv/releases/osmani-latest.apk',
  sha256: '',
})

const defaultPopup = () => ({
  mode: 'once',
  title: 'Welcome to Osmani TV',
  greeting: 'Hello!',
  introduction: 'Discover live sports, movies, and family channels in one place.',
  bullets: ['HD streams where available', 'Manage subscriptions anytime', 'Support via WhatsApp'],
  disclaimer: 'Content availability may vary by region.',
})

const defaultDeviceControl = () => ({
  transferMode: 'confirmation',
  dailyLimit: 5,
  weeklyLimit: 15,
  cooldownMinutes: 60,
  pending: [],
  logs: [],
})

const defaultSecuritySuite = () => ({
  protectionMode: 'manual',
  whitelist: [],
  blockedUsers: [],
  alerts: [],
})

const defaultDashboard = () => ({
  totalAppInstalls: 0,
  liveUsersByCountry: [],
  mostWatchedChannels: [],
})

async function readArr(name) {
  const v = await readJson(FILES[name], [])
  return Array.isArray(v) ? v : []
}

async function writeArr(name, arr) {
  await writeJsonAtomic(FILES[name], arr)
}

async function readObj(name, def) {
  const v = await readJson(FILES[name], null)
  if (!v || typeof v !== 'object' || Array.isArray(v)) return def()
  return { ...def(), ...v }
}

export const restApi = Router()

restApi.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'osmani-admin-api' })
})

restApi.use('/channels', channelsRouter)

/** --- Generic array CRUD (string id) --- */
function mountArrayCrud(routeName, fileKey, { postValidate, mapPost } = {}) {
  restApi.get(`/${routeName}`, async (_req, res) => {
    try {
      res.json(await readArr(fileKey))
    } catch {
      res.status(500).json({ error: 'read failed' })
    }
  })

  restApi.post(`/${routeName}`, async (req, res) => {
    try {
      if (postValidate) {
        const err = postValidate(req.body)
        if (err) return res.status(400).json({ error: err })
      }
      const list = await readArr(fileKey)
      const id = randomUUID()
      const row = mapPost ? mapPost(req.body, id) : { ...req.body, id }
      list.push(row)
      await writeArr(fileKey, list)
      res.status(201).json(row)
    } catch {
      res.status(500).json({ error: 'create failed' })
    }
  })

  restApi.put(`/${routeName}/:id`, async (req, res) => {
    try {
      const { id } = req.params
      const list = await readArr(fileKey)
      const idx = list.findIndex((x) => String(x.id) === String(id))
      if (idx === -1) return res.status(404).json({ error: 'not found' })
      const merged = { ...list[idx], ...req.body, id: list[idx].id }
      list[idx] = merged
      await writeArr(fileKey, list)
      res.json(merged)
    } catch {
      res.status(500).json({ error: 'update failed' })
    }
  })

  restApi.delete(`/${routeName}/:id`, async (req, res) => {
    try {
      const { id } = req.params
      const list = await readArr(fileKey)
      const next = list.filter((x) => String(x.id) !== String(id))
      if (next.length === list.length) return res.status(404).json({ error: 'not found' })
      await writeArr(fileKey, next)
      res.status(204).send()
    } catch {
      res.status(500).json({ error: 'delete failed' })
    }
  })
}

mountArrayCrud('banners', 'banners', {
  postValidate: (b) => {
    if (!b?.title || !String(b.title).trim()) return 'title is required'
    if (!b?.description || !String(b.description).trim()) return 'description is required'
    return null
  },
  mapPost: (b, id) => ({
    ...b,
    id,
    createdAt: new Date().toISOString(),
  }),
})

mountArrayCrud('plans', 'plans', {
  postValidate: (b) => {
    if (!b?.name || !String(b.name).trim()) return 'name is required'
    const price = Number(b.price)
    if (!Number.isFinite(price) || price < 0) return 'valid price is required'
    return null
  },
  mapPost: (b, id) => ({
    id,
    name: String(b.name).trim(),
    price: Number(b.price),
    durationDays: Math.max(1, Math.floor(Number(b.durationDays) || 30)),
    expiryType: b.expiryType === 'fixed' ? 'fixed' : 'duration',
    fixedExpiryTime:
      typeof b.fixedExpiryTime === 'string' && b.fixedExpiryTime
        ? b.fixedExpiryTime.slice(0, 5)
        : '00:00',
    isActive: b.isActive === undefined ? true : Boolean(b.isActive),
    createdAt: new Date().toISOString(),
  }),
})

mountArrayCrud('users', 'users', {
  postValidate: (b) => {
    if (!b?.phone || !String(b.phone).trim()) return 'phone is required'
    return null
  },
  mapPost: (b, id) => ({
    id,
    phone: String(b.phone).trim(),
    device: String(b.device || '').trim() || '—',
    planId: b.planId || '',
    planName: String(b.planName || '').trim() || '—',
    amount: Number(b.amount) || 0,
    startDate: b.startDate || new Date().toISOString(),
    expiryDate: b.expiryDate || new Date().toISOString(),
    countryCode: b.countryCode || '',
    countryName: b.countryName || '',
    status: b.status || 'online',
  }),
})

restApi.get('/transactions', async (_req, res) => {
  try {
    const list = await readArr('transactions')
    res.json([...list].sort((a, b) => new Date(b.date) - new Date(a.date)))
  } catch {
    res.status(500).json({ error: 'read failed' })
  }
})

restApi.post('/transactions', async (req, res) => {
  try {
    const list = await readArr('transactions')
    const id = randomUUID()
    const row = {
      id,
      phone: String(req.body?.phone || '').trim() || '+255000000000',
      plan: String(req.body?.plan || '').trim() || '—',
      amount: Number(req.body?.amount) || 0,
      orderId: String(req.body?.orderId || '').trim() || `ORD-${id.slice(0, 8)}`,
      status: ['completed', 'pending', 'failed'].includes(req.body?.status)
        ? req.body.status
        : 'completed',
      date: req.body?.date || new Date().toISOString(),
    }
    list.unshift(row)
    await writeArr('transactions', list)
    res.status(201).json(row)
  } catch {
    res.status(500).json({ error: 'create failed' })
  }
})

mountArrayCrud('notifications', 'notifications', {
  postValidate: (b) => {
    if (!b?.title || !String(b.title).trim()) return 'title is required'
    if (!b?.message || !String(b.message).trim()) return 'message is required'
    return null
  },
  mapPost: (b, id) => ({
    id,
    title: String(b.title).trim(),
    message: String(b.message).trim(),
    image: String(b.image || ''),
    targetAudience: b.targetAudience || 'all',
    targetType: String(b.targetType || 'osmani://home').trim(),
    scheduleAt: b.scheduleAt || null,
    status: b.status || 'sent',
    sentAt:
      b.sentAt != null
        ? b.sentAt
        : b.status === 'scheduled'
          ? null
          : new Date().toISOString(),
    clicks: Number(b.clicks) || 0,
    createdAt: new Date().toISOString(),
  }),
})

mountArrayCrud('transfer-codes', 'transferCodes', {
  postValidate: (b) => {
    if (!b?.code || !String(b.code).trim()) return 'code is required'
    return null
  },
  mapPost: (b, id) => ({
    id,
    code: String(b.code).trim(),
    deviceUser: String(b.deviceUser || 'Unassigned device').trim(),
    createdAt: b.createdAt || new Date().toISOString(),
    expiresAt: b.expiresAt || new Date(Date.now() + 86400000 * 2).toISOString(),
    status: ['active', 'used', 'revoked', 'expired'].includes(b.status) ? b.status : 'active',
  }),
})

/** --- Singleton settings GET/PUT --- */
function mountSetting(route, fileKey, defaults) {
  restApi.get(route, async (_req, res) => {
    try {
      res.json(await readObj(fileKey, defaults))
    } catch {
      res.status(500).json({ error: 'read failed' })
    }
  })
  restApi.put(route, async (req, res) => {
    try {
      const cur = await readObj(fileKey, defaults)
      const next = { ...cur, ...req.body }
      await writeJsonAtomic(FILES[fileKey], next)
      res.json(next)
    } catch {
      res.status(500).json({ error: 'write failed' })
    }
  })
}

mountSetting('/settings/zenopay', 'zenopay', defaultZenopay)
mountSetting('/settings/whatsapp', 'whatsapp', defaultWhatsapp)
mountSetting('/settings/app-update', 'appUpdate', defaultAppUpdate)
mountSetting('/settings/popup', 'popup', defaultPopup)
mountSetting('/settings/device-control', 'deviceControl', defaultDeviceControl)
mountSetting('/settings/security-suite', 'securitySuite', defaultSecuritySuite)
mountSetting('/settings/dashboard', 'dashboard', defaultDashboard)

restApi.post('/settings/zenopay/test', async (req, res) => {
  const url = String(req.body?.apiEndpoint || '').trim()
  if (!url) return res.status(400).json({ ok: false, message: 'apiEndpoint required' })
  const t0 = Date.now()
  const ctrl = new AbortController()
  const tid = setTimeout(() => ctrl.abort(), 10000)
  try {
    const r = await fetch(url, { method: 'GET', signal: ctrl.signal, redirect: 'follow' })
    const ms = Date.now() - t0
    res.json({
      ok: r.ok,
      message: r.ok ? `HTTP ${r.status} · ${ms} ms` : `HTTP ${r.status} · ${ms} ms`,
    })
  } catch (e) {
    res.json({ ok: false, message: e.name === 'AbortError' ? 'Timeout' : String(e.message || e) })
  } finally {
    clearTimeout(tid)
  }
})

/** Security logs */
restApi.get('/security-logs', async (_req, res) => {
  try {
    const list = await readArr('securityLogs')
    res.json(list)
  } catch {
    res.status(500).json({ error: 'read failed' })
  }
})

restApi.post('/security-logs', async (req, res) => {
  try {
    const list = await readArr('securityLogs')
    const row = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      actor: String(req.body?.actor || 'System'),
      eventType: String(req.body?.eventType || 'Event'),
      status: req.body?.status === 'failed' ? 'failed' : 'completed',
      detail: String(req.body?.detail || ''),
    }
    list.unshift(row)
    await writeArr('securityLogs', list.slice(0, 800))
    res.status(201).json(row)
  } catch {
    res.status(500).json({ error: 'append failed' })
  }
})

/** Analytics aggregate (real TX + users) */
restApi.get('/analytics/summary', async (_req, res) => {
  try {
    const transactions = await readArr('transactions')
    const users = await readArr('users')
    const channels = await readJson('channels.json', [])
    const chList = Array.isArray(channels) ? channels : []
    res.json({
      transactions,
      users,
      channelCount: chList.length,
    })
  } catch {
    res.status(500).json({ error: 'failed' })
  }
})

/** Dashboard merged view */
restApi.get('/dashboard', async (_req, res) => {
  try {
    const stored = await readObj('dashboard', defaultDashboard)
    const users = await readArr('users')
    const tx = await readArr('transactions')
    const channels = await readJson('channels.json', [])
    const chList = Array.isArray(channels) ? channels : []
    const now = Date.now()
    const activeSubs = users.filter((u) => new Date(u.expiryDate).getTime() > now).length

    const planCounts = new Map()
    for (const t of tx) {
      if (t.status !== 'completed') continue
      const k = t.plan || 'Other'
      planCounts.set(k, (planCounts.get(k) || 0) + 1)
    }
    const fromTx = [...planCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, watchers], i) => ({
        id: `tx-${i}`,
        name,
        watchers,
      }))

    const liveUsers =
      Array.isArray(stored.liveUsersByCountry) && stored.liveUsersByCountry.length > 0
        ? stored.liveUsersByCountry
        : aggregateUsersForMap(users)

    const mostWatched =
      Array.isArray(stored.mostWatchedChannels) && stored.mostWatchedChannels.length > 0
        ? stored.mostWatchedChannels
        : fromTx.length > 0
          ? fromTx
          : chList.slice(0, 6).map((c, i) => ({
              id: String(c.id ?? i),
              name: c.name || `Channel ${i + 1}`,
              watchers: 0,
            }))

    const totalInstalls =
      typeof stored.totalAppInstalls === 'number' && stored.totalAppInstalls > 0
        ? stored.totalAppInstalls
        : Math.max(activeSubs + tx.length, users.length)

    res.json({
      totalAppInstalls: totalInstalls,
      liveUsersByCountry: liveUsers,
      mostWatchedChannels: mostWatched,
      activeSubscriptions: activeSubs,
      channelCount: chList.length,
    })
  } catch {
    res.status(500).json({ error: 'failed' })
  }
})

function aggregateUsersForMap(users) {
  const map = new Map()
  for (const u of users) {
    if (u.status && u.status !== 'online') continue
    const code = (u.countryCode || 'TZ').toUpperCase().slice(0, 2)
    const name = u.countryName || countryNameFromCode(code)
    const key = code
    const cur = map.get(key) || { countryCode: key, countryName: name, count: 0, status: 'online' }
    cur.count += 1
    map.set(key, cur)
  }
  return [...map.values()].sort((a, b) => b.count - a.count)
}

function countryNameFromCode(code) {
  const m = { TZ: 'Tanzania', KE: 'Kenya', UG: 'Uganda', RW: 'Rwanda' }
  return m[code] || code
}

/** Server health: probe channel stream URLs */
async function probeStreamUrl(url) {
  const t0 = Date.now()
  const ctrl = new AbortController()
  const tid = setTimeout(() => ctrl.abort(), 8000)
  try {
    let r = await fetch(url, { method: 'HEAD', signal: ctrl.signal, redirect: 'follow' }).catch(
      () => null,
    )
    if (!r || !r.ok) {
      r = await fetch(url, {
        method: 'GET',
        signal: ctrl.signal,
        redirect: 'follow',
        headers: { Range: 'bytes=0-0' },
      })
    }
    const ms = Date.now() - t0
    return { online: r.ok, ms: r.ok ? ms : 0, error: r.ok ? '' : `HTTP ${r.status}` }
  } catch (e) {
    return {
      online: false,
      ms: 0,
      error: e.name === 'AbortError' ? 'Timeout' : String(e.message || e),
    }
  } finally {
    clearTimeout(tid)
  }
}

restApi.get('/server-health', async (_req, res) => {
  try {
    const channels = await readJson('channels.json', [])
    const channelList = Array.isArray(channels) ? channels : []
    const rows = await Promise.all(
      channelList.map(async (ch) => {
        const name = ch.name || 'Channel'
        const url = (ch.url || ch.streamUrl || '').trim()
        if (!url) {
          return { id: String(ch.id ?? name), name, online: false, ms: 0, error: 'No stream URL' }
        }
        const probe = await probeStreamUrl(url)
        return {
          id: String(ch.id ?? name),
          name,
          ...probe,
        }
      }),
    )
    res.json({ checkedAt: new Date().toISOString(), channels: rows })
  } catch {
    res.status(500).json({ error: 'probe failed' })
  }
})

const WHITELIST_TEMPLATE = [
  '102.90.12.44 · Head office',
  '41.59.21.88 · CDN edge',
  'Pixel 8 · +255712000001',
  'TV-Box A12 · living-room',
  'api.osmani.tv · health probe',
  '197.250.8.1 · Partner POP',
]

restApi.post('/settings/security-suite/restore-whitelist', async (_req, res) => {
  try {
    const suite = await readObj('securitySuite', defaultSecuritySuite)
    const next = {
      ...suite,
      whitelist: WHITELIST_TEMPLATE.map((value) => ({ id: randomUUID(), value })),
    }
    await writeJsonAtomic(FILES.securitySuite, next)
    res.json(next)
  } catch {
    res.status(500).json({ error: 'failed' })
  }
})

export async function ensureAllApiDataFiles() {
  await ensureJsonFile('channels.json', '[]\n')
  await ensureJsonFile(FILES.banners, '[]\n')
  await ensureJsonFile(FILES.plans, '[]\n')
  await ensureJsonFile(FILES.users, '[]\n')
  await ensureJsonFile(FILES.transactions, '[]\n')
  await ensureJsonFile(FILES.notifications, '[]\n')
  await ensureJsonFile(FILES.transferCodes, '[]\n')
  await ensureJsonFile(FILES.zenopay, `${JSON.stringify(defaultZenopay(), null, 2)}\n`)
  await ensureJsonFile(FILES.whatsapp, `${JSON.stringify(defaultWhatsapp(), null, 2)}\n`)
  await ensureJsonFile(FILES.appUpdate, `${JSON.stringify(defaultAppUpdate(), null, 2)}\n`)
  await ensureJsonFile(FILES.popup, `${JSON.stringify(defaultPopup(), null, 2)}\n`)
  await ensureJsonFile(FILES.deviceControl, `${JSON.stringify(defaultDeviceControl(), null, 2)}\n`)
  await ensureJsonFile(FILES.securitySuite, `${JSON.stringify(defaultSecuritySuite(), null, 2)}\n`)
  await ensureJsonFile(FILES.securityLogs, '[]\n')
  await ensureJsonFile(FILES.dashboard, `${JSON.stringify(defaultDashboard(), null, 2)}\n`)
}
