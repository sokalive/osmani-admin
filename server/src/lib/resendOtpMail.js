/**
 * Sends OTP via Resend API (RESEND_API_KEY).
 */

export async function sendAdminOtpEmail({ to, otp }) {
  const key = String(process.env.RESEND_API_KEY ?? '').trim()
  const from = String(process.env.RESEND_FROM_EMAIL ?? '').trim()
  if (!key || !from) {
    console.warn('[resend] RESEND_API_KEY or RESEND_FROM_EMAIL missing — OTP email skipped')
    return { ok: false, skipped: true }
  }

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width"/></head>
<body style="margin:0;background:#0b0f1a;color:#e2e8f0;font-family:system-ui,Segoe UI,Roboto,sans-serif;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0b0f1a;padding:32px 16px;">
<tr><td align="center">
  <table width="560" style="background:#111827;border-radius:16px;border:1px solid #334155;overflow:hidden;max-width:100%;">
    <tr><td style="padding:28px 28px 12px;">
      <p style="margin:0;font-size:11px;letter-spacing:0.25em;text-transform:uppercase;color:#fbbf24;">Osmani TV Admin</p>
      <h1 style="margin:12px 0 8px;font-size:22px;color:#fff;">Security verification</h1>
      <p style="margin:0 0 20px;font-size:14px;color:#94a3b8;line-height:1.6;">
        Use this one-time code to verify this browser as a trusted admin device. The code expires in <strong>5 minutes</strong>.
      </p>
      <div style="background:#0f172a;border-radius:12px;padding:20px;text-align:center;border:1px solid #475569;">
        <p style="margin:0 0 8px;font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;">Your code</p>
        <p style="margin:0;font-size:32px;font-weight:700;letter-spacing:0.35em;color:#fbbf24;font-family:ui-monospace,monospace;">${otp}</p>
      </div>
      <p style="margin:24px 0 0;font-size:13px;color:#f87171;line-height:1.6;">
        If you did not attempt to sign in, do not share this code. Someone may be trying to access your admin account.
      </p>
    </td></tr>
    <tr><td style="padding:16px 28px 28px;border-top:1px solid #1e293b;">
      <p style="margin:0;font-size:11px;color:#64748b;">This is an automated security message from Osmani TV administration.</p>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: 'Osmani Admin security code',
      html,
    }),
  })

  const text = await res.text()
  if (!res.ok) {
    console.error('[resend] failed', res.status, text)
    return { ok: false, error: text }
  }
  return { ok: true }
}

/** OTP for destructive analytics reset — sent to ADMIN_ALERT_EMAIL only. */
export async function sendAnalyticsResetOtpEmail({ to, otp }) {
  const key = String(process.env.RESEND_API_KEY ?? '').trim()
  const from = String(process.env.RESEND_FROM_EMAIL ?? '').trim()
  if (!key || !from) {
    console.warn('[resend] RESEND_API_KEY or RESEND_FROM_EMAIL missing — analytics reset OTP skipped')
    return { ok: false, skipped: true }
  }
  if (!to) {
    return { ok: false, error: 'ADMIN_ALERT_EMAIL not configured' }
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: 'Osmani Admin — install analytics reset code',
      html: `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;background:#0b0f1a;color:#e2e8f0;padding:24px;">
        <p style="font-size:11px;text-transform:uppercase;letter-spacing:0.2em;color:#f87171;">Danger zone</p>
        <h1 style="color:#fff;">Install analytics reset</h1>
        <p>Use this one-time code within <strong>5 minutes</strong>:</p>
        <p style="font-size:32px;font-weight:bold;letter-spacing:0.35em;color:#fbbf24;font-family:monospace;">${otp}</p>
        <p style="color:#94a3b8;font-size:13px;">If you did not request this, ignore this email and review admin access.</p>
      </body></html>`,
    }),
  })

  const text = await res.text()
  if (!res.ok) {
    console.error('[resend] analytics reset OTP failed', res.status, text)
    return { ok: false, error: text }
  }
  return { ok: true }
}

/** Admin Security page gate OTP — sent to ADMIN_ALERT_EMAIL only. */
export async function sendAdminSecurityGateOtpEmail({ to, otp }) {
  const key = String(process.env.RESEND_API_KEY ?? '').trim()
  const from = String(process.env.RESEND_FROM_EMAIL ?? '').trim()
  if (!key || !from) {
    console.warn('[resend] RESEND_API_KEY or RESEND_FROM_EMAIL missing — admin security gate OTP skipped')
    return { ok: false, skipped: true }
  }
  if (!to) {
    return { ok: false, error: 'ADMIN_ALERT_EMAIL not configured' }
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: 'Osmani Admin — Security page access code',
      html: `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;background:#0b0f1a;color:#e2e8f0;padding:24px;">
        <p style="font-size:11px;text-transform:uppercase;letter-spacing:0.2em;color:#34d399;">Admin Security</p>
        <h1 style="color:#fff;">Trusted devices access</h1>
        <p>Enter this code within <strong>5 minutes</strong> after your PIN:</p>
        <p style="font-size:32px;font-weight:bold;letter-spacing:0.35em;color:#fbbf24;font-family:monospace;">${otp}</p>
        <p style="color:#94a3b8;font-size:13px;">Single-use. If you did not request this, secure your admin account immediately.</p>
      </body></html>`,
    }),
  })

  const text = await res.text()
  if (!res.ok) {
    console.error('[resend] admin security gate OTP failed', res.status, text)
    return { ok: false, error: text }
  }
  return { ok: true }
}
