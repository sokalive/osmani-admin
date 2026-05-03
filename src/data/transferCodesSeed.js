const USERS = [
  'Pixel 8 / user_8821',
  'Samsung A54 / user_4410',
  'TV-Box Pro / user_1203',
  'iPhone 14 / user_9912',
  'Web guest / anon',
]

function id() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `tc-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function randomTransferCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const seg = (n) =>
    Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
  return `${seg(4)}-${seg(4)}`
}

/** Build demo codes: mix of active (future expiry), used, expired */
export function generateTransferCodes(count = 14) {
  const now = Date.now()
  const list = []
  for (let i = 0; i < count; i++) {
    const r = Math.random()
    const created = new Date(now - Math.random() * 86400000 * 10)
    let status = 'active'
    let expiresAt = new Date(created.getTime() + (20 + Math.random() * 100) * 3600000)
    if (r < 0.25) {
      status = 'used'
      expiresAt = new Date(created.getTime() + 3600000)
    } else if (r < 0.42) {
      status = 'expired'
      expiresAt = new Date(created.getTime() + 3600000)
    } else if (r < 0.48) {
      status = 'revoked'
      expiresAt = new Date(created.getTime() + 48 * 3600000)
    }
    if (status === 'active' && expiresAt.getTime() <= now) {
      status = 'expired'
    }
    list.push({
      id: id(),
      code: randomTransferCode(),
      deviceUser: USERS[Math.floor(Math.random() * USERS.length)],
      createdAt: created.toISOString(),
      expiresAt: expiresAt.toISOString(),
      status,
    })
  }
  return list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
}
