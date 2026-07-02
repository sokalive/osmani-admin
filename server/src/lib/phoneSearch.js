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
    parts.push(`EXISTS (
      SELECT 1 FROM device_phone_registry dpr_s
      WHERE dpr_s.device_id::text = ${deviceCol}
        AND dpr_s.phone_number_normalized = $${idx}
    )`)
    params.push(digits)
    idx += 1
    parts.push(`EXISTS (
      SELECT 1 FROM transactions t_s
      WHERE t_s.device_id::text = ${deviceCol}
        AND (
          ${tzPhoneCanonicalSql('t_s.phone::text')} = $${idx}
          OR ${tzPhoneCanonicalSql("t_s.raw_payload->>'phoneNorm'")} = $${idx}
          OR ${tzPhoneCanonicalSql("t_s.raw_payload->>'phone'")} = $${idx}
          OR ${tzPhoneCanonicalSql("t_s.raw_payload->'sonicpesa'->'data'->>'msisdn'")} = $${idx}
          OR ${tzPhoneCanonicalSql("t_s.raw_payload->'auraxpay'->>'customer_phone'")} = $${idx}
          OR ${tzPhoneCanonicalSql("t_s.raw_payload->'auraxpay'->'data'->>'phone'")} = $${idx}
          OR ${tzPhoneCanonicalSql("t_s.raw_payload->'order_status_poll'->'data'->>'msisdn'")} = $${idx}
        )
    )`)
    params.push(digits)
    idx += 1
  }
  cond.push(`(${parts.join(' OR ')})`)
  return idx
}
