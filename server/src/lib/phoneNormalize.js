/**
 * Worldwide phone normalization for device registry + SMS (not payment checkout).
 * Accepts optional +, digits, spaces, dashes, parentheses.
 */
export function normalizePhoneInternational(raw, { defaultCountry = 'TZ' } = {}) {
  const original = String(raw ?? '').trim()
  if (!original) {
    return { raw: '', normalized: '', valid: false, error: 'phone is required' }
  }

  let digits = original.replace(/[^\d+]/g, '')
  if (digits.startsWith('+')) digits = digits.slice(1)
  digits = digits.replace(/\D/g, '')

  if (!digits) {
    return { raw: original, normalized: '', valid: false, error: 'phone has no digits' }
  }

  const dc = String(defaultCountry ?? 'TZ').trim().toUpperCase()
  if (dc === 'TZ') {
    if (/^0\d{9}$/.test(digits)) digits = `255${digits.slice(1)}`
    else if (/^[67]\d{8}$/.test(digits)) digits = `255${digits}`
    else if (/^255\d{9}$/.test(digits)) digits = digits
  }

  if (digits.length < 8 || digits.length > 15) {
    return {
      raw: original,
      normalized: '',
      valid: false,
      error: 'phone must be 8–15 digits after normalization',
    }
  }

  return { raw: original, normalized: digits, valid: true, error: null }
}
