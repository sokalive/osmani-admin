/**
 * International phone normalization for device profile capture.
 * Accepts worldwide formats; Tanzania local 07… is upgraded to 255… digits.
 */

/**
 * @param {unknown} raw
 * @returns {{ digits: string; e164: string } | null}
 */
export function normalizeInternationalPhone(raw) {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) return null

  let digits = trimmed.replace(/[^\d+]/g, '')
  if (digits.startsWith('+')) digits = digits.slice(1)
  digits = digits.replace(/\D/g, '')
  if (!digits) return null

  if (/^0[67]\d{8}$/.test(digits)) {
    digits = `255${digits.slice(1)}`
  } else if (/^[67]\d{8}$/.test(digits)) {
    digits = `255${digits}`
  }

  if (digits.length < 8 || digits.length > 15) return null
  if (/^(\d)\1+$/.test(digits)) return null

  return { digits, e164: `+${digits}` }
}

/**
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isValidInternationalPhone(raw) {
  return normalizeInternationalPhone(raw) != null
}
