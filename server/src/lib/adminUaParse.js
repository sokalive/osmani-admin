/**
 * Best-effort UA parsing for Security Center display (not used as device identity).
 */
export function parseAdminUserAgent(uaRaw) {
  const ua = String(uaRaw ?? '').slice(0, 500)
  let browser = 'Unknown'
  let osName = 'Unknown'
  let deviceType = 'Desktop'

  if (/Edg\//i.test(ua)) browser = 'Edge'
  else if (/OPR\/|Opera/i.test(ua)) browser = 'Opera'
  else if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) browser = 'Chrome'
  else if (/Firefox\//i.test(ua)) browser = 'Firefox'
  else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) browser = 'Safari'
  else if (/MSIE|Trident/i.test(ua)) browser = 'IE'
  else if (ua) browser = ua.split(/\s+/)[0] || 'Unknown'

  if (/Android/i.test(ua)) {
    osName = 'Android'
    deviceType = 'Mobile'
    const m = /Android\s+([\d._]+)/i.exec(ua)
    if (m) osName = `Android ${m[1]}`
  } else if (/iPhone|iPad|iPod/i.test(ua)) {
    osName = 'iOS'
    deviceType = /iPad/i.test(ua) ? 'Tablet' : 'Mobile'
    const m = /OS\s+([\d_]+)/i.exec(ua)
    if (m) osName = `iOS ${m[1].replace(/_/g, '.')}`
  } else if (/Windows NT 10/i.test(ua)) osName = 'Windows 10/11'
  else if (/Windows NT 6\.3/i.test(ua)) osName = 'Windows 8.1'
  else if (/Windows/i.test(ua)) osName = 'Windows'
  else if (/Mac OS X/i.test(ua)) {
    osName = 'macOS'
    const m = /Mac OS X\s+([\d_]+)/i.exec(ua)
    if (m) osName = `macOS ${m[1].replace(/_/g, '.')}`
  } else if (/Linux/i.test(ua)) osName = 'Linux'

  if (/Mobile|Android.*Mobile/i.test(ua) && deviceType === 'Desktop') deviceType = 'Mobile'
  if (/Tablet|iPad/i.test(ua)) deviceType = 'Tablet'

  return {
    browser,
    osName,
    deviceType,
    userAgent: ua,
  }
}

export function defaultDeviceName({ deviceType, osName }) {
  if (deviceType === 'Mobile') return `Mobile (${osName})`
  if (deviceType === 'Tablet') return `Tablet (${osName})`
  return `PC (${osName})`
}
