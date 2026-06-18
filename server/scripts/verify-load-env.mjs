/**
 * Unit test: loadEnv parses export-prefixed DATABASE_URL and repo-root .env.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loadenv-test-'))
const serverRoot = path.join(tmp, 'server')
fs.mkdirSync(path.join(serverRoot, 'src'), { recursive: true })

const loadEnvSrc = fs.readFileSync(
  new URL('../src/loadEnv.js', import.meta.url),
  'utf8',
)
fs.writeFileSync(path.join(serverRoot, 'src', 'loadEnv.js'), loadEnvSrc)
fs.writeFileSync(
  path.join(serverRoot, '.env.cutover'),
  'PORT=10001\nBUNNY_CDN_BASE_URL=https://osmanitv.b-cdn.net\n',
)
fs.writeFileSync(
  path.join(tmp, '.env'),
  'export DATABASE_URL=postgresql://user:pass@155.138.223.205:5432/osmani_db\n',
)

process.chdir(serverRoot)
delete process.env.DATABASE_URL
delete process.env.BUNNY_CDN_BASE_URL

const mod = await import(pathToFileURL(path.join(serverRoot, 'src', 'loadEnv.js')).href)
mod.loadProcessEnv()

assert.equal(mod.isDatabaseUrlConfigured(), true)
assert.match(String(process.env.DATABASE_URL), /155\.138\.223\.205/)
assert.equal(process.env.BUNNY_CDN_BASE_URL, 'https://osmanitv.b-cdn.net')

console.log('verify-load-env: OK')
