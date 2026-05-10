export function adminAuthAudit(action, extra = {}) {
  console.log(
    '[admin_auth_audit]',
    JSON.stringify({
      action,
      ...extra,
      timestamp: new Date().toISOString(),
    }),
  )
}
