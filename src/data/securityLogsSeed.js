const EVENTS = [
  'Code transfer',
  'Device handshake',
  'Session refresh',
  'Admin login',
  'API authentication',
  'Policy enforcement',
  'Stream entitlement check',
]

const ACTORS = [
  '+255712000001',
  '+255744332211',
  'user_8821',
  'user_4410',
  'device_tv_living',
  'api-worker-east',
]

function id() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `lg-${Date.now()}`
}

function randomIsoPast(days = 10) {
  return new Date(Date.now() - Math.random() * 86400000 * days).toISOString()
}

export function generateSecurityLogs(count = 14) {
  const list = []
  for (let i = 0; i < count; i++) {
    const ok = Math.random() > 0.18
    list.push({
      id: id(),
      timestamp: randomIsoPast(12),
      actor: ACTORS[Math.floor(Math.random() * ACTORS.length)],
      eventType: EVENTS[Math.floor(Math.random() * EVENTS.length)],
      status: ok ? 'completed' : 'failed',
      detail: ok
        ? `ref:${Math.random().toString(36).slice(2, 10)} · latency ${40 + Math.floor(Math.random() * 200)}ms`
        : `err:${['AUTH_401', 'TIMEOUT', 'RATE_LIMIT', 'INVALID_SIG'][Math.floor(Math.random() * 4)]}`,
    })
  }
  return list.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
}
