/**
 * Prevent browsers and shared caches from serving stale JSON after admin writes.
 * Mount on the `/api` router so paths are matched after the `/api` prefix.
 *
 * Does not cover public catalog (`/plans`, `/channels`, …) — those stay cache-friendly.
 */
export function applySensitiveJsonGetNoStore(req, res, next) {
  if (req.method !== 'GET') return next()

  const pathPart = String(req.url || '').split('?')[0]
  const full = `${req.baseUrl || ''}${pathPart}` || '/'
  const p = full.startsWith('/api') ? full.slice(4) || '/' : full

  const noStore =
    p === '/health' ||
    p.startsWith('/admin/') ||
    p === '/settings' ||
    p.startsWith('/settings/') ||
    p === '/users' ||
    p.startsWith('/users/') ||
    p === '/transactions' ||
    p.startsWith('/transactions/') ||
    p === '/dashboard' ||
    p.startsWith('/dashboard/') ||
    p.startsWith('/analytics/') ||
    p.startsWith('/admin/analytics/') ||
    p === '/notifications' ||
    p.startsWith('/notifications/') ||
    p === '/security-logs' ||
    p.startsWith('/security-logs/') ||
    p === '/security/stats' ||
    p.startsWith('/security/') ||
    p === '/transfer-codes' ||
    p.startsWith('/transfer-codes/') ||
    p === '/server-health' ||
    p.startsWith('/server-health/') ||
    p.startsWith('/payment-status/') ||
    p === '/payment-status' ||
    p === '/payments/checkout-providers' ||
    p === '/update-check' ||
    p.startsWith('/update-check/')

  if (noStore) {
    res.setHeader('Cache-Control', 'no-store, private, must-revalidate, proxy-revalidate')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Vary', 'Authorization, X-Admin-Token, Origin')
  }
  next()
}
