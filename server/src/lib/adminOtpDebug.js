/** OTP values are never returned in production API responses. */
export function adminOtpDebugHint(otpPlain) {
  if (
    String(process.env.ADMIN_OTP_DEBUG_RETURN || '') === '1' &&
    String(process.env.NODE_ENV || '').toLowerCase() !== 'production'
  ) {
    return otpPlain
  }
  return undefined
}
