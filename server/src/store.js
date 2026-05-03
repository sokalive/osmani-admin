import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_PATH = path.join(__dirname, '../data/channels.json')
const TMP_PATH = `${DATA_PATH}.tmp`

export async function ensureDataFile() {
  await fs.mkdir(path.dirname(DATA_PATH), { recursive: true })
  try {
    await fs.access(DATA_PATH)
  } catch {
    await fs.writeFile(DATA_PATH, '[]\n', 'utf8')
  }
}

export async function readChannels() {
  try {
    const raw = await fs.readFile(DATA_PATH, 'utf8')
    const parsed = JSON.parse(raw || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Atomic replace: write temp then rename (same volume). */
export async function writeChannels(channels) {
  const payload = `${JSON.stringify(channels, null, 2)}\n`
  try {
    await fs.writeFile(TMP_PATH, payload, 'utf8')
    await fs.rename(TMP_PATH, DATA_PATH)
  } catch (e) {
    await fs.unlink(TMP_PATH).catch(() => {})
    throw e
  }
}
