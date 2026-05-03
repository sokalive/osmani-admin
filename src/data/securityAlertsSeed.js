const TITLES = [
  'Multiple login attempts',
  'Unusual location sign-in',
  'API rate limit exceeded',
  'Suspicious device fingerprint',
  'Password reset storm',
  'New admin session from unknown IP',
  'Card verification failures',
  'Stream token replay detected',
  'High-severity policy violation',
  'Brute force on support account',
  'Certificate pinning mismatch',
  'Geo-blocked region access',
]

const DEVICES = [
  'Pixel 8 · 102.90.12.44',
  'iPhone 15 · 197.250.8.1',
  'SM-A546 · 41.59.21.88',
  'Chrome · 102.88.14.2',
  'Android TV · 196.11.44.90',
  'Safari · 154.72.3.11',
]

function id() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `sa-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function randomIsoInLastHours(maxH) {
  const ms = Date.now() - Math.random() * maxH * 3600000
  return new Date(ms).toISOString()
}

export function generateSecurityAlerts(count = 12) {
  const list = []
  for (let i = 0; i < count; i++) {
    const critical = Math.random() < 0.28
    const resolved = Math.random() < 0.42
    const kindRoll = Math.random()
    const kind = kindRoll < 0.38 ? 'pattern' : kindRoll < 0.72 ? 'login' : 'device'
    list.push({
      id: id(),
      title: TITLES[Math.floor(Math.random() * TITLES.length)],
      deviceOrIp: DEVICES[Math.floor(Math.random() * DEVICES.length)],
      time: randomIsoInLastHours(72),
      status: resolved ? 'resolved' : 'active',
      severity: critical ? 'critical' : Math.random() < 0.5 ? 'warning' : 'info',
      kind,
    })
  }
  return list.sort((a, b) => new Date(b.time) - new Date(a.time))
}
