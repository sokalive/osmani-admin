/**
 * Purge Bunny pull zone cache for HLS segment paths (/hls/seg*).
 *
 * Env: BUNNY_API_KEY (Account API key), BUNNY_PULL_ZONE_ID (numeric pull zone id)
 * Optional: BUNNY_STREAM_SEGMENT_PATH (default hls/seg)
 */
const apiKey = String(process.env.BUNNY_API_KEY || '').trim()
const zoneId = String(process.env.BUNNY_PULL_ZONE_ID || process.env.BUNNY_ZONE_ID || '').trim()
const segPath = String(process.env.BUNNY_STREAM_SEGMENT_PATH || 'hls/seg').replace(/^\/+/, '')

if (!apiKey || !zoneId) {
  console.error('Set BUNNY_API_KEY and BUNNY_PULL_ZONE_ID to purge Bunny cache.')
  process.exit(1)
}

const paths = [`/${segPath}`, `/${segPath}/*`]

for (const path of paths) {
  const res = await fetch(`https://api.bunny.net/pullzone/${zoneId}/purgeCache`, {
    method: 'POST',
    headers: {
      AccessKey: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ path }),
  })
  const text = await res.text()
  console.log(JSON.stringify({ path, status: res.status, body: text.slice(0, 200) }))
  if (!res.ok) process.exit(1)
}

console.log('purge-bunny-hls-seg: OK')
