/**
 * Unit checks for appendPublicAssetCacheRevision (no network).
 */
import assert from 'node:assert/strict'
import { appendPublicAssetCacheRevision } from '../src/lib/cdnAssets.js'

const base = 'https://api.osmanitv.com/uploads/demo.webp'
const withV = appendPublicAssetCacheRevision(base, '2026-08-13T22:21:12.578Z')
assert.ok(withV.includes('v='), withV)
assert.equal(new URL(withV).searchParams.get('v'), String(Date.parse('2026-08-13T22:21:12.578Z')))

const once = appendPublicAssetCacheRevision(withV, Date.now())
assert.equal(once, withV, 'must not overwrite existing v=')

assert.equal(appendPublicAssetCacheRevision(null, Date.now()), null)
assert.equal(appendPublicAssetCacheRevision('data:image/png;base64,xx', Date.now()), 'data:image/png;base64,xx')
assert.equal(appendPublicAssetCacheRevision(base, ''), base)

console.log('PASS appendPublicAssetCacheRevision')
