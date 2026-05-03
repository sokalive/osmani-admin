import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const DATA_DIR = path.join(__dirname, '../../data')

export function dataPath(name) {
  return path.join(DATA_DIR, name)
}

export async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true })
}

export async function ensureJsonFile(relName, initialSerialized) {
  await ensureDir()
  const p = dataPath(relName)
  try {
    await fs.access(p)
  } catch {
    await fs.writeFile(p, initialSerialized, 'utf8')
  }
}

export async function readJson(relName, fallback) {
  const p = dataPath(relName)
  try {
    const raw = await fs.readFile(p, 'utf8')
    const v = JSON.parse(raw || 'null')
    return v === undefined || v === null ? fallback : v
  } catch {
    return fallback
  }
}

export async function writeJsonAtomic(relName, value) {
  const p = dataPath(relName)
  const tmp = `${p}.tmp`
  const payload = `${JSON.stringify(value, null, 2)}\n`
  try {
    await fs.writeFile(tmp, payload, 'utf8')
    await fs.rename(tmp, p)
  } catch (e) {
    await fs.unlink(tmp).catch(() => {})
    throw e
  }
}
