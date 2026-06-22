/**
 * Coalesce concurrent verify access DB reads for the same device_id.
 */
/** @type {Map<string, Promise<{ row: object|null, pendingTxn: object|null }>>} */
const inflight = new Map()

/**
 * @param {string} deviceId
 * @param {() => Promise<{ row: object|null, pendingTxn: object|null }>} loader
 */
export async function coalesceVerifyAccessLoad(deviceId, loader) {
  const d = String(deviceId ?? '').trim()
  if (!d) return loader()
  const existing = inflight.get(d)
  if (existing) return existing
  const p = loader().finally(() => {
    if (inflight.get(d) === p) inflight.delete(d)
  })
  inflight.set(d, p)
  return p
}

export function clearVerifyAccessInflightForDevice(deviceId) {
  const d = String(deviceId ?? '').trim()
  if (!d) return
  inflight.delete(d)
}

export function clearVerifyAccessInflight() {
  inflight.clear()
}
