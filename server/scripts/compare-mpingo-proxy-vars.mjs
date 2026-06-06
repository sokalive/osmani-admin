import { injectMpingoHtmlBaseHref } from '../src/lib/streamMpingoHtmlBase.js'

const UA =
  'Mozilla/5.0 (Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36'

function pick(body, name) {
  const m = body.match(new RegExp(`var ${name}\\s*=\\s*"([^"]*)"`, 'i'))
  return m ? m[1] : null
}

for (const ch of [1, 2]) {
  const url = `https://nur.mpingotv.com/v3/player.php?channel=${ch}`
  const upRes = await fetch(url, { headers: { 'User-Agent': UA } })
  const upBody = await upRes.text()
  const proxied = injectMpingoHtmlBaseHref(upBody, url)

  const proxyUrl = `https://osmani-admin-api.onrender.com/stream-proxy?url=${encodeURIComponent(url)}&origin=https%3A%2F%2Fnur.mpingotv.com&userAgent=${encodeURIComponent(UA)}`
  const liveRes = await fetch(proxyUrl, { headers: { 'User-Agent': UA } })
  const liveBody = await liveRes.text()

  console.log(
    JSON.stringify(
      {
        channel: ch,
        upstream: {
          clearKey: pick(upBody, 'clearKey'),
          detectedIdentity: pick(upBody, 'detectedIdentity'),
          streamUrlPresent: Boolean(pick(upBody, 'streamUrl')),
        },
        local_proxy_injection: {
          clearKey: pick(proxied, 'clearKey'),
          detectedIdentity: pick(proxied, 'detectedIdentity'),
          hasBaseTag: /data-osmani-mpingo-base/i.test(proxied),
        },
        live_stream_proxy: {
          status: liveRes.status,
          clearKey: pick(liveBody, 'clearKey'),
          detectedIdentity: pick(liveBody, 'detectedIdentity'),
          hasBaseTag: /data-osmani-mpingo-base/i.test(liveBody),
          modified_vs_upstream:
            pick(upBody, 'clearKey') !== pick(liveBody, 'clearKey') ||
            pick(upBody, 'detectedIdentity') !== pick(liveBody, 'detectedIdentity'),
        },
      },
      null,
      2
    )
  )
}
