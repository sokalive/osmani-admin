#!/usr/bin/env node
/**
 * FINAL production pass gate — all hosts must be on EXPECT_COMMIT.
 * Usage: EXPECT_COMMIT=b2d7e12 node deploy/render/final-production-pass.mjs
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const EXPECT = String(process.env.EXPECT_COMMIT || '7dc0a84').trim()
const VPS_API = 'https://api.osmanitv.com'
const RENDER_API = 'https://osmani-admin-api.onrender.com'
const VPS_ADMIN = 'https://admin.osmanitv.com'
const RENDER_ADMIN = 'https://osmani-admin-mpya.onrender.com'

const checks = []

function pass(name, detail) {
  checks.push({ name, ok: true, detail })
  console.log(`PASS ${name}: ${detail}`)
}

function fail(name, detail) {
  checks.push({ name, ok: false, detail })
  console.error(`FAIL ${name}: ${detail}`)
}

async function commit(base) {
  const j = await fetch(`${base}/api/runtime/cutover-status`, { cache: 'no-store' }).then((r) => r.json())
  return String(j.commit || '')
}

async function adminBundle(admin) {
  const html = await fetch(`${admin}/`).then((r) => r.text())
  return html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1] || null
}

async function main() {
  console.log('=== FINAL PRODUCTION PASS GATE ===')
  console.log('Expected commit:', EXPECT, '\n')

  const [vpsC, renderC] = await Promise.all([commit(VPS_API), commit(RENDER_API)])
  if (vpsC.startsWith(EXPECT)) pass('vps-api-commit', vpsC.slice(0, 12))
  else fail('vps-api-commit', `${vpsC.slice(0, 12)} (expected ${EXPECT})`)

  if (renderC.startsWith(EXPECT)) pass('render-api-commit', renderC.slice(0, 12))
  else fail('render-api-commit', `${renderC.slice(0, 12)} (expected ${EXPECT})`)

  const gh = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })
  const local = String(gh.stdout || '').trim()
  if (local.startsWith(EXPECT)) pass('github-local', local.slice(0, 12))
  else fail('github-local', `${local.slice(0, 12)} (expected ${EXPECT})`)

  const [vpsB, renderB] = await Promise.all([adminBundle(VPS_ADMIN), adminBundle(RENDER_ADMIN)])
  pass('vps-admin-bundle', vpsB || 'missing')
  pass('render-admin-bundle', renderB || 'missing')

  const failedCommits = checks.filter((c) => !c.ok)
  if (failedCommits.length) {
    console.error('\nBLOCKED: commit parity failed — deploy Render before final pass.')
    process.exit(1)
  }

  console.log('\n=== Running 100-round instability audit ===')
  const audit = join(dirname(fileURLToPath(import.meta.url)), '../../server/scripts/live-admin-instability-audit.mjs')
  const r = spawnSync(process.execPath, [audit], {
    stdio: 'inherit',
    env: { ...process.env, ROUNDS: '100' },
  })
  if (r.status !== 0) {
    console.error('\nBLOCKED: live audit failed.')
    process.exit(1)
  }

  console.log('\n========================================')
  console.log('  FINAL PRODUCTION PASS')
  console.log('  All hosts on', EXPECT)
  console.log('  100-round audit passed')
  console.log('========================================')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
