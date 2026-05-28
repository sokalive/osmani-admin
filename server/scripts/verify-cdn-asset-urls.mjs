/**
 * Smoke-test CDN URL resolution (no network). Run from server/: node scripts/verify-cdn-asset-urls.mjs
 */
import assert from 'node:assert/strict'
import {
  extractUploadPath,
  getCdnBaseUrl,
  isCdnEnabled,
  isOriginOnlyUploadPath,
  resolvePublicAssetUrl,
} from '../src/lib/cdnAssets.js'

const ORIGIN = 'https://osmani-admin-api.onrender.com'
const CDN = 'https://osmani-media.b-cdn.net'

process.env.BASE_URL = ORIGIN
process.env.BUNNY_CDN_BASE_URL = CDN

assert.equal(isCdnEnabled(), true)
assert.equal(getCdnBaseUrl(), CDN)

const thumb = resolvePublicAssetUrl('/uploads/abc.jpg', null)
assert.equal(thumb, `${CDN}/uploads/abc.jpg`)

const legacy = resolvePublicAssetUrl(`${ORIGIN}/uploads/abc.jpg`, null)
assert.equal(legacy, `${CDN}/uploads/abc.jpg`)

const apk = resolvePublicAssetUrl('/uploads/apks/app-v1.apk', null)
assert.equal(apk, `${ORIGIN}/uploads/apks/app-v1.apk`)
assert.equal(isOriginOnlyUploadPath(apk), true)

const external = resolvePublicAssetUrl('https://cdn.example.com/promo.png', null)
assert.equal(external, 'https://cdn.example.com/promo.png')

delete process.env.BUNNY_CDN_BASE_URL
const fallback = resolvePublicAssetUrl('/uploads/x.png', null)
assert.equal(fallback, `${ORIGIN}/uploads/x.png`)

assert.equal(extractUploadPath('https://osmani-admin-api.onrender.com/uploads/foo.webp'), '/uploads/foo.webp')

console.log('verify-cdn-asset-urls: OK')
