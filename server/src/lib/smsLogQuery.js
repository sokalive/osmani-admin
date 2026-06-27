/**
 * Server-side SMS history filters for admin log listing.
 */

function trim(s, max = 200) {
  return String(s ?? '')
    .trim()
    .slice(0, max)
}

function parseIsoDate(value) {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function digitsOnly(value) {
  return String(value ?? '').replace(/\D/g, '')
}

/**
 * @param {object} opts
 * @returns {{ whereSql: string, params: unknown[], limit: number, offset: number }}
 */
export function buildSmsLogListQuery(opts = {}) {
  const limit = Math.min(100, Math.max(1, Number(opts.limit) || 25))
  const offset = Math.max(0, Number(opts.offset) || 0)

  const clauses = []
  const params = []

  const add = (sql, ...values) => {
    let idx = params.length
    const sqlWithParams = sql.replace(/\?/g, () => {
      idx += 1
      return `$${idx}`
    })
    clauses.push(sqlWithParams)
    params.push(...values)
  }

  const status = trim(opts.status, 32).toLowerCase()
  if (status && status !== 'all') {
    if (status === 'failed') {
      clauses.push(`status IN ('failed', 'phone_missing')`)
    } else {
      add('status = ?', status)
    }
  }

  const trigger = trim(opts.trigger, 64).toLowerCase()
  if (trigger && trigger !== 'all') {
    if (trigger === 'payment_success') {
      clauses.push(
        `(trigger_type = 'payment_success' OR sms_type = 'payment_success' OR template_key = 'payment_success')`,
      )
    } else if (trigger === 'expiry_reminder') {
      clauses.push(
        `(trigger_type = 'expiry_reminder' OR sms_type = 'expiry_reminder' OR template_key = 'expiry_reminder')`,
      )
    } else if (trigger === 'expired') {
      clauses.push(`(trigger_type = 'expired' OR sms_type = 'expired' OR template_key = 'expired')`)
    } else if (trigger === 'admin_broadcast') {
      clauses.push(
        `(trigger_type LIKE 'broadcast_%' OR trigger_type IN ('manual_single', 'manual', 'broadcast') OR trigger_type LIKE 'resend_%')`,
      )
    } else if (trigger === 'other') {
      clauses.push(`(
        trigger_type NOT IN ('payment_success', 'expiry_reminder', 'expired', 'manual_single', 'manual', 'broadcast')
        AND trigger_type NOT LIKE 'broadcast_%'
        AND trigger_type NOT LIKE 'resend_%'
        AND COALESCE(sms_type, '') NOT IN ('payment_success', 'expiry_reminder', 'expired')
        AND COALESCE(template_key, '') NOT IN ('payment_success', 'expiry_reminder', 'expired')
      )`)
    }
  }

  const recipient = trim(opts.recipient, 32)
  if (recipient) {
    const digits = digitsOnly(recipient)
    if (digits.length >= 6) {
      add(
        `(regexp_replace(recipient, '[^0-9]', '', 'g') LIKE '%' || ? || '%' OR recipient ILIKE '%' || ? || '%')`,
        digits,
        recipient,
      )
    } else {
      add('recipient ILIKE ?', `%${recipient}%`)
    }
  }

  const dateFrom = parseIsoDate(opts.dateFrom ?? opts.date_from)
  if (dateFrom) add('created_at >= ?::timestamptz', dateFrom)

  const dateTo = parseIsoDate(opts.dateTo ?? opts.date_to)
  if (dateTo) add('created_at <= ?::timestamptz', dateTo)

  const q = trim(opts.search ?? opts.q, 120)
  if (q) {
    const like = `%${q}%`
    const digits = digitsOnly(q)
    if (digits.length >= 6) {
      add(
        `(
          recipient ILIKE ?
          OR message ILIKE ?
          OR trigger_type ILIKE ?
          OR template_key ILIKE ?
          OR sms_type ILIKE ?
          OR status ILIKE ?
          OR device_id ILIKE ?
          OR provider_message_id ILIKE ?
          OR payment_id ILIKE ?
          OR subscription_id ILIKE ?
          OR regexp_replace(recipient, '[^0-9]', '', 'g') LIKE '%' || ? || '%'
        )`,
        like,
        like,
        like,
        like,
        like,
        like,
        like,
        like,
        like,
        like,
        digits,
      )
    } else {
      add(
        `(
          recipient ILIKE ?
          OR message ILIKE ?
          OR trigger_type ILIKE ?
          OR template_key ILIKE ?
          OR sms_type ILIKE ?
          OR status ILIKE ?
          OR device_id ILIKE ?
          OR provider_message_id ILIKE ?
          OR payment_id ILIKE ?
          OR subscription_id ILIKE ?
        )`,
        like,
        like,
        like,
        like,
        like,
        like,
        like,
        like,
        like,
        like,
      )
    }
  }

  const whereSql = clauses.length > 0 ? clauses.join(' AND ') : 'TRUE'
  return { whereSql, params, limit, offset }
}

export const SMS_LOG_SELECT_COLUMNS = `id, recipient, device_id, message, template_key, trigger_type, status,
            provider_response, provider_message_id, sms_type, subscription_id, payment_id, created_at`
