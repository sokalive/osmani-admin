/** Smoke test loadPm2Env.cjs (run on VPS after deploy). */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '../..')
const require = createRequire(import.meta.url)
const { loadContaboPm2Env } = require(path.join(root, 'deploy/contabo/loadPm2Env.cjs'))

const env = loadContaboPm2Env(root)
if (!String(env.DATABASE_URL || '').trim()) {
  console.error('FAIL: DATABASE_URL not loaded from disk')
  process.exit(1)
}
console.log('OK DATABASE_URL', env.DATABASE_URL.length, 'chars')
console.log('OK BUNNY', env.BUNNY_CDN_BASE_URL || '(unset)')
console.log('OK commit', env.OSMANI_GIT_COMMIT || '(unknown)')
