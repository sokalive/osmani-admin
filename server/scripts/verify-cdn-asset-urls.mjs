/**
 * Smoke-test CDN URL resolution (no network). Run from server/: npm run verify:cdn-assets
 */
import assert from 'node:assert/strict'
import {
  extractUploadPath,
  getCdnBaseUrl,
  isBunnyCdnOriginPullRequest,
  isCdnEnabled,
  isHostedApkPath,
  resolveHostedApkDownloadUrl,
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
assert.equal(apk, `${CDN}/uploads/apks/app-v1.apk`)
assert.equal(isHostedApkPath(apk), true)
assert.equal(
  resolveHostedApkDownloadUrl(`${ORIGIN}/uploads/apks/osmani-v17.apk`, null),
  `${CDN}/uploads/apks/osmani-v17.apk`,
)

const playUrl = resolveHostedApkDownloadUrl('https://play.google.com/store/apps/details?id=tv.osmani', null)
assert.equal(playUrl, 'https://play.google.com/store/apps/details?id=tv.osmani')

const external = resolvePublicAssetUrl('https://cdn.example.com/promo.png', null)
assert.equal(external, 'https://cdn.example.com/promo.png')

delete process.env.BUNNY_CDN_BASE_URL
const fallback = resolvePublicAssetUrl('/uploads/x.png', null)
assert.equal(fallback, `${ORIGIN}/uploads/x.png`)
const apkFallback = resolveHostedApkDownloadUrl('/uploads/apks/x.apk', null)
assert.equal(apkFallback, `${ORIGIN}/uploads/apks/x.apk`)

assert.equal(extractUploadPath('https://osmani-admin-api.onrender.com/uploads/foo.webp'), '/uploads/foo.webp')

assert.equal(
  isBunnyCdnOriginPullRequest({ headers: { 'user-agent': 'BunnyCDN/1.0' } }),
  true,
)
assert.equal(isBunnyCdnOriginPullRequest({ headers: { 'user-agent': 'Mozilla/5.0' } }), false)

console.log('verify-cdn-asset-urls: OK')
