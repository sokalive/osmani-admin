/** Demo / offline transaction generator — realistic TZ phones, plans, amounts */

const PLAN_ROWS = [
  { plan: 'Daily Pass', amount: 2000 },
  { plan: 'Monthly Pro', amount: 15000 },
  { plan: 'Yearly', amount: 120000 },
]

function randomPhoneTz() {
  let n = ''
  for (let i = 0; i < 9; i++) n += Math.floor(Math.random() * 10)
  return `+255${n}`
}

function randomOrderId() {
  const part = Math.random().toString(36).substring(2, 11).toUpperCase()
  return `ORD-${part}`
}

function newId(prefix) {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/** Weighted status — most payments succeed */
function randomStatus() {
  const r = Math.random()
  if (r < 0.64) return 'completed'
  if (r < 0.83) return 'pending'
  return 'failed'
}

/** Spread across last `daySpan` calendar days with random clock time */
function randomIsoWithinDays(daySpan) {
  const now = Date.now()
  const offsetMs = Math.floor(Math.random() * daySpan * 86400000)
  const d = new Date(now - offsetMs)
  d.setHours(
    Math.floor(Math.random() * 24),
    Math.floor(Math.random() * 60),
    Math.floor(Math.random() * 60),
    0,
  )
  return d.toISOString()
}

/**
 * @param {number} count
 * @returns {Array<{ id: string, phone: string, plan: string, amount: number, orderId: string, status: string, date: string }>}
 */
export function generateDemoTransactions(count) {
  const list = []
  for (let i = 0; i < count; i++) {
    const row = PLAN_ROWS[Math.floor(Math.random() * PLAN_ROWS.length)]
    list.push({
      id: newId('tx'),
      phone: randomPhoneTz(),
      plan: row.plan,
      amount: row.amount,
      orderId: randomOrderId(),
      status: randomStatus(),
      date: randomIsoWithinDays(14),
    })
  }
  return list.sort((a, b) => new Date(b.date) - new Date(a.date))
}

/**
 * One new transaction (for live simulation) — always “now”
 */
export function createLiveDemoTransaction() {
  const row = PLAN_ROWS[Math.floor(Math.random() * PLAN_ROWS.length)]
  const status = randomStatus()
  const now = new Date()
  return {
    id: newId('live'),
    phone: randomPhoneTz(),
    plan: row.plan,
    amount: row.amount,
    orderId: randomOrderId(),
    status,
    date: now.toISOString(),
  }
}
