/**
 * Regression: Contabo and Render must resolve the trusted-admin login gate identically,
 * and disabling the login screen must never disable X-Admin-Token enforcement.
 *
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

/** Boot loadEnv.js in a child process so each case gets a clean process.env. */
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
      env: { ...process.env, ADMIN_PANEL_AUTH_REQUIRED: 'true', OSMANI_VPS: '', RENDER: '', ADMIN_TRUSTED_INSTALL: '', ...env },
    },
  )
  if (res.status !== 0) throw new Error(`loadEnv probe failed: ${res.stderr}`)
  return res.stdout.trim().split('\n').pop().trim()
}

check('Contabo VPS opens dashboard directly', resolvePanelAuth({ OSMANI_VPS: '1' }), 'false')
check('Render opens dashboard directly', resolvePanelAuth({ RENDER: 'true' }), 'false')
check('Contabo and Render agree', resolvePanelAuth({ OSMANI_VPS: '1' }), resolvePanelAuth({ RENDER: 'true' }))
check('Untrusted host keeps interactive login', resolvePanelAuth({}), 'true')
check('ADMIN_TRUSTED_INSTALL=0 restores login on Render', resolvePanelAuth({ RENDER: 'true', ADMIN_TRUSTED_INSTALL: '0' }), 'true')
check('ADMIN_TRUSTED_INSTALL=0 restores login on Contabo', resolvePanelAuth({ OSMANI_VPS: '1', ADMIN_TRUSTED_INSTALL: '0' }), 'true')

// Trusted install must still reject requests without a valid X-Admin-Token.
process.env.ADMIN_PANEL_AUTH_REQUIRED = 'false'
process.env.ADMIN_API_TOKEN = 'regression-token'
const { requireAdminPanelAccess } = await import('../src/middleware/adminPanelAuthGate.js')

function runGate(headers) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code
        return this
      },
      json(body) {
        resolve({ status: this.statusCode, body })
      },
    }
    void requireAdminPanelAccess({ headers }, res, () => resolve({ status: 200, body: { passed: true } }))
  })
}

check('missing token rejected', (await runGate({})).status, 403)
check('wrong token rejected', (await runGate({ 'x-admin-token': 'nope' })).status, 403)
check('valid token accepted', (await runGate({ 'x-admin-token': 'regression-token' })).status, 200)

if (failures.length) {
  console.error(`\n${failures.length} regression check(s) failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nAll trusted-admin install regression checks passed.')
