import { normalizePhoneDigits, tzPhoneCanonicalSql } from '../billingStore.js'

function escapeLike(q) {
  return String(q).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

/**
 * Admin search: device_id substring + phone ILIKE + canonical digit match.
 * @param {string[]} phoneExprs SQL expressions for phone columns
 */
export function appendAdminPhoneDeviceSearch(search, deviceCol, phoneExprs, cond, params, i) {
  const q = String(search ?? '').trim()
  if (!q) return i
  const parts = [`${deviceCol} ILIKE $${i}`]
  params.push(`%${escapeLike(q)}%`)
  let idx = i + 1
  for (const expr of phoneExprs) {
    parts.push(`${expr} ILIKE $${idx}`)
    params.push(`%${escapeLike(q)}%`)
    idx += 1
  }
  const digits = normalizePhoneDigits(q)
  if (digits && digits.length >= 9) {
    for (const expr of phoneExprs) {
      parts.push(`${tzPhoneCanonicalSql(expr)} = $${idx}`)
      params.push(digits)
      idx += 1
    }
  }
  cond.push(`(${parts.join(' OR ')})`)
  return idx
}
