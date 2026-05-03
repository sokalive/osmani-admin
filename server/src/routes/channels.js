import { Router } from 'express'
import { mergeStoredWithBody, storedChannelFromBody } from '../mapChannel.js'
import { bodyToInsert } from '../normalizeBody.js'
import { readChannels, writeChannels } from '../store.js'

export const channelsRouter = Router()

channelsRouter.get('/', async (_req, res) => {
  try {
    const list = await readChannels()
    const sorted = [...list].sort((a, b) => Number(a.id) - Number(b.id))
    res.json(sorted)
  } catch (e) {
    res.status(500).json({ error: 'Failed to load channels' })
  }
})

channelsRouter.post('/', async (req, res) => {
  try {
    const b = bodyToInsert(req.body)
    if (!b.name || !b.url) {
      return res.status(400).json({ error: 'name and url (stream URL) are required' })
    }
    const list = await readChannels()
    const nextId =
      list.length === 0 ? 1 : Math.max(...list.map((c) => Number(c.id)), 0) + 1
    const now = new Date().toISOString()
    const created = storedChannelFromBody(req.body, nextId, now, now)
    list.push(created)
    await writeChannels(list)
    res.status(201).json(created)
  } catch (e) {
    res.status(500).json({ error: 'Failed to create channel' })
  }
})

channelsRouter.put('/:id', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10)
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: 'Invalid id' })
    }
    const b = bodyToInsert(req.body)
    if (!b.name || !b.url) {
      return res.status(400).json({ error: 'name and url (stream URL) are required' })
    }
    const list = await readChannels()
    const idx = list.findIndex((c) => Number(c.id) === id)
    if (idx === -1) {
      return res.status(404).json({ error: 'Channel not found' })
    }
    const updated = mergeStoredWithBody(list[idx], req.body)
    list[idx] = updated
    await writeChannels(list)
    res.json(updated)
  } catch (e) {
    res.status(500).json({ error: 'Failed to update channel' })
  }
})

channelsRouter.delete('/:id', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10)
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: 'Invalid id' })
    }
    const list = await readChannels()
    const next = list.filter((c) => Number(c.id) !== id)
    if (next.length === list.length) {
      return res.status(404).json({ error: 'Channel not found' })
    }
    await writeChannels(next)
    res.status(204).send()
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete channel' })
  }
})
