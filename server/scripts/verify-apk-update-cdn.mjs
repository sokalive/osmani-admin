/**
 * Verify OTA endpoints expose Bunny APK URLs when CDN is configured.
 * Usage: node scripts/verify-apk-update-cdn.mjs [API_BASE_URL]
 */
const base = (process.argv[2] || process.env.API_BASE_URL || 'https://osmani-admin-api.onrender.com').replace(
  /\/$/,
  '',
)

async function main() {
  const endpoints = ['/api/update-check', '/api/runtime/app-update']
  let sawHostedApk = false

  for (const path of endpoints) {
    const res = await fetch(`${base}${path}`)
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      console.error(`FAIL ${path}: HTTP ${res.status}`, body)
      process.exit(1)
    }
    const apkUrl = String(body.apk_url ?? '').trim()
    console.log(`${path}: apk_url=${apkUrl || '(empty)'}`)
    if (apkUrl.includes('/uploads/apks/')) {
      sawHostedApk = true
      if (!apkUrl.includes('b-cdn.net')) {
        console.warn(`WARN ${path}: hosted APK URL is not on Bunny CDN yet — set BUNNY_CDN_BASE_URL on Render`)
      } else {
        console.log(`OK ${path}: APK URL uses Bunny CDN`)
      }
    }
  }

  const health = await fetch(`${base}/api/health/media`).then((r) => r.json())
  console.log('health.cdn:', JSON.stringify(health.cdn ?? {}))
  if (health.cdn?.apkDeliveryViaCdn === true) {
    console.log('OK: apkDeliveryViaCdn enabled')
  }

  if (!sawHostedApk) {
    console.log('SKIP: no hosted APK URL configured in app_settings (upload an APK first)')
  }
  console.log('verify-apk-update-cdn: done')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
