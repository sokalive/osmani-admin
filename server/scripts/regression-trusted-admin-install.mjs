/**
 * Copied-project flags and a shared admin token cannot disable Osmani admin login.
 * Usage: node server/scripts/regression-trusted-admin-install.mjs
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverRoot = path.join(here, '..')

const failures = []
function check(name, actual, expected) {
  const ok = actual === expected
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — expected ${expected}, got ${actual}`)
  if (!ok) failures.push(name)
}

function resolvePanelAuth(env) {
  const res = spawnSync(
    process.execPath,
    [
      '-e',
      "import('./src/loadEnv.js').then(() => console.log(String(process.env.ADMIN_PANEL_AUTH_REQUIRED ?? 'unset')))",
    ],
    {
      cwd: serverRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ADMIN_PANEL_AUTH_REQUIRED: 'true',
        OSMANI_VPS: '',
        RENDER: '',
        ADMIN_TRUSTED_INSTALL: '',
        LUQMAN_VPS: '',
        ...env,
      },
    },
  )
  if (res.status !== 0) throw new Error(`loadEnv probe failed: ${res.stderr}`)
  return res.stdout.trim().split('\n').pop().trim()
}

check('Contabo VPS keeps login required', resolvePanelAuth({ OSMANI_VPS: '1' }), 'true')
check('Render keeps login required', resolvePanelAuth({ RENDER: 'true' }), 'true')
check('LUQMAN_VPS cannot disable login', resolvePanelAuth({ LUQMAN_VPS: '1', ADMIN_PANEL_AUTH_REQUIRED: 'false' }), 'true')
check('ADMIN_TRUSTED_INSTALL=1 cannot disable login', resolvePanelAuth({ ADMIN_TRUSTED_INSTALL: '1' }), 'true')
check('Trusted install on Contabo cannot disable login', resolvePanelAuth({ OSMANI_VPS: '1', ADMIN_TRUSTED_INSTALL: '1' }), 'true')
check('ADMIN_TRUSTED_INSTALL=0 keeps login', resolvePanelAuth({ ADMIN_TRUSTED_INSTALL: '0' }), 'true')

process.env.ADMIN_PANEL_AUTH_REQUIRED = 'false'
process.env.ADMIN_PANEL_LEGACY_TOKEN_FALLBACK = 'true'
process.env.ADMIN_API_TOKEN = 'regression-token'
const { requireAdminPanelAccess } = await import('../src/middleware/adminPanelAuthGate.js')

function runGate(headers) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      locals: {},
      status(code) {
        this.statusCode = code
        return this
      },
      json(body) {
        resolve({ status: this.statusCode, body })
      },
      on() {},
    }
    void requireAdminPanelAccess({ headers, method: 'GET' }, res, () => resolve({ status: 200, body: { passed: true } }))
  })
}

check('missing session rejected', (await runGate({})).status, 401)
check('wrong token rejected', (await runGate({ 'x-admin-token': 'nope' })).status, 401)
check('legacy token rejected', (await runGate({ 'x-admin-token': 'regression-token' })).status, 401)

if (failures.length) {
  console.error(`\n${failures.length} regression check(s) failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nAll trusted-admin install regression checks passed.')
