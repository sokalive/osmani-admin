import { Router } from 'express'
import { readJson } from '../lib/jsonFile.js'

const USERS_FILE = 'users.json'

/** Minimal read until users are migrated to PostgreSQL. */
export const usersRouter = Router()

usersRouter.get('/', async (_req, res) => {
  try {
    const data = await readJson(USERS_FILE, [])
    res.json(Array.isArray(data) ? data : [])
  } catch {
    res.status(500).json({ error: 'Failed to load users' })
  }
})
