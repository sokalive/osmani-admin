/** Allowed runtime overlay pill positions (banner image). */
export const RUNTIME_POSITION_VALUES = Object.freeze([
  'center',
  'bottom_center',
  'bottom_left',
  'bottom_right',
  'top_left',
  'top_right',
])

export const DEFAULT_RUNTIME_POSITION = 'center'

/**
 * Safe read for API responses — null/empty/invalid → center (backward compatible).
 */
export function normalizeRuntimePosition(value) {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_')
  if (!raw) return DEFAULT_RUNTIME_POSITION
  return RUNTIME_POSITION_VALUES.includes(raw) ? raw : DEFAULT_RUNTIME_POSITION
}

/**
 * Parse from create/update body. Omitted or empty → default; invalid → error object.
 */
export function parseRuntimePositionFromBody(body = {}) {
  const b = body && typeof body === 'object' ? body : {}
  const raw = b.runtime_position ?? b.runtimePosition
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { value: DEFAULT_RUNTIME_POSITION }
  }
  const normalized = String(raw).trim().toLowerCase().replace(/-/g, '_')
  if (!RUNTIME_POSITION_VALUES.includes(normalized)) {
    return {
      error: `runtime_position must be one of: ${RUNTIME_POSITION_VALUES.join(', ')}`,
    }
  }
  return { value: normalized }
}
