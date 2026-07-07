/**
 * Authoritative Payment Order recovery / lifecycle classification (display-only).
 * Aligns TRUE_UNRESOLVED with strict critical_unresolved_completed row semantics.
 */

export const RECOVERY_CLASS = Object.freeze({
  ALREADY_ACTIVE: 'ALREADY_ACTIVE',
  ADMIN_REVOKED: 'ADMIN_REVOKED',
  HAMISHA_TRANSFER: 'HAMISHA_TRANSFER',
  SYSTEM_MIGRATION: 'SYSTEM_MIGRATION',
  SUPERSEDED_STACKED: 'SUPERSEDED_STACKED',
  EXPIRED: 'EXPIRED',
  MANUAL_GRANT_OVERRIDE: 'MANUAL_GRANT_OVERRIDE',
  ACTIVATED_HISTORICAL: 'ACTIVATED_HISTORICAL',
  TRUE_UNRESOLVED: 'TRUE_UNRESOLVED',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
  MANUALLY_RECOVERED: 'MANUALLY_RECOVERED',
  RECOVERY_REJECTED: 'RECOVERY_REJECTED',
  PENDING_PROVIDER: 'PENDING_PROVIDER',
  FAILED_PROVIDER: 'FAILED_PROVIDER',
})

export const RECOVERY_LABEL = Object.freeze({
  [RECOVERY_CLASS.ALREADY_ACTIVE]: 'Already Active',
  [RECOVERY_CLASS.ADMIN_REVOKED]: 'Admin Revoked',
  [RECOVERY_CLASS.HAMISHA_TRANSFER]: 'Hamisha Transfer',
  [RECOVERY_CLASS.SYSTEM_MIGRATION]: 'System Migration',
  [RECOVERY_CLASS.SUPERSEDED_STACKED]: 'Superseded / Stacked',
  [RECOVERY_CLASS.EXPIRED]: 'Expired',
  [RECOVERY_CLASS.MANUAL_GRANT_OVERRIDE]: 'Manual Grant Override',
  [RECOVERY_CLASS.ACTIVATED_HISTORICAL]: 'Activated / Historical',
  [RECOVERY_CLASS.TRUE_UNRESOLVED]: 'Unresolved Activation',
  [RECOVERY_CLASS.NEEDS_REVIEW]: 'Needs Review',
  [RECOVERY_CLASS.MANUALLY_RECOVERED]: 'Manually Recovered',
  [RECOVERY_CLASS.RECOVERY_REJECTED]: 'Recovery Rejected',
  [RECOVERY_CLASS.PENDING_PROVIDER]: 'Pending at Provider',
  [RECOVERY_CLASS.FAILED_PROVIDER]: 'Failed at Provider',
})

export const RECOVERY_SEVERITY = Object.freeze({
  success: 'success',
  info: 'info',
  neutral: 'neutral',
  warning: 'warning',
  danger: 'danger',
})

function parseDate(v) {
  if (v == null || v === '') return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

function norm(row, snake, camel) {
  return row?.[snake] ?? row?.[camel] ?? ''
}

/**
 * Parse `moved:{sourceDeviceId}:{embeddedTransactionId}` with exact canonical comparison.
 * @param {unknown} transactionId
 * @returns {{
 *   isMoved: boolean,
 *   sourceDeviceId?: string,
 *   embeddedTransactionId?: string,
 *   malformed?: boolean,
 *   legacy?: boolean,
 * }}
 */
export function parseMovedTransactionId(transactionId) {
  const s = String(transactionId ?? '').trim()
  if (!s.startsWith('moved:')) return { isMoved: false }

  const m64 = /^moved:([a-f0-9]{64}):(.+)$/i.exec(s)
  if (m64) {
    return {
      isMoved: true,
      sourceDeviceId: m64[1].toLowerCase(),
      embeddedTransactionId: m64[2],
    }
  }

  const mLoose = /^moved:([^:]+):(.+)$/i.exec(s)
  if (mLoose) {
    return {
      isMoved: true,
      sourceDeviceId: mLoose[1],
      embeddedTransactionId: mLoose[2],
      legacy: true,
    }
  }

  return { isMoved: true, malformed: true, sourceDeviceId: '', embeddedTransactionId: '' }
}

/**
 * Same row-level predicate as sonicpesa critical_unresolved_completed (per order).
 * Metric applies a time/provider window; this function is scope-agnostic per row.
 */
export function isStrictUnresolvedCompletedOrder(row) {
  const oid = String(norm(row, 'order_id', 'orderId')).trim()
  const st = String(norm(row, 'status', 'status')).toLowerCase()
  if (st !== 'completed' || !oid) return false
  if (!String(norm(row, 'device_id', 'deviceId')).trim()) return false

  const recovery = String(norm(row, 'recovery_state', 'recoveryState')).toUpperCase()
  if (recovery === 'MANUALLY_APPROVED' || recovery === 'RECOVERY_REJECTED') return false

  const subTxn = String(norm(row, 'sub_transaction_id', 'subTransactionId')).trim()
  if (!subTxn || subTxn !== oid) return false
  if (subTxn.startsWith('moved:') || subTxn.startsWith('recovery:')) return false

  const subStatus = String(norm(row, 'sub_status', 'subStatus')).toLowerCase()
  return subStatus !== 'active'
}

function subTxnIsActiveAnchor(row) {
  const oid = String(norm(row, 'order_id', 'orderId')).trim()
  const subTxn = String(norm(row, 'sub_transaction_id', 'subTransactionId')).trim()
  const subStatus = String(norm(row, 'sub_status', 'subStatus')).toLowerCase()
  const exp = parseDate(norm(row, 'sub_expires_at', 'subExpiresAt'))
  return (
    subStatus === 'active' &&
    exp != null &&
    exp.getTime() > Date.now() &&
    subTxn === oid
  )
}

function hasActivationEvidence(row) {
  const raw = row?.raw_payload && typeof row.raw_payload === 'object' ? row.raw_payload : {}
  if (raw.activation_result != null) return true
  if (raw.canonical_activation === true) return true
  if (String(raw.activation_state ?? '').trim()) return true
  if (row?.last_recovery_action) return true
  return false
}

function hasCausalHamishaTransfer(row, orderId) {
  const hamishaId = String(norm(row, 'hamisha_transfer_id', 'hamishaTransferId')).trim()
  if (!hamishaId) return false

  const subTxn = String(norm(row, 'sub_transaction_id', 'subTransactionId')).trim()
  if (subTxn.startsWith('moved:')) return false
  if (subTxn !== orderId) return false

  const orderCompletedAt = parseDate(norm(row, 'completed_at', 'completedAt'))
  const orderCreatedAt = parseDate(norm(row, 'created_at', 'createdAt'))
  const transferCompletedAt = parseDate(
    norm(row, 'hamisha_transfer_completed_at', 'hamishaTransferCompletedAt'),
  )
  const orderAnchorAt = orderCompletedAt ?? orderCreatedAt
  if (orderAnchorAt && transferCompletedAt && orderAnchorAt.getTime() > transferCompletedAt.getTime()) {
    return false
  }

  return true
}

function hasCausalSystemMigration(subTxn, orderId) {
  const moved = parseMovedTransactionId(subTxn)
  if (!moved.isMoved || moved.malformed) return false
  const embedded = String(moved.embeddedTransactionId ?? '').trim()
  return embedded !== '' && embedded === orderId
}

/**
 * @param {object} row — transaction + joined subscription evidence
 * @returns {{
 *   recoveryClass: string,
 *   recoveryLabel: string,
 *   recoveryReason: string,
 *   recoverySeverity: string,
 *   recoveryActionable: boolean,
 *   recoveryEvidence: string[],
 * }}
 */
export function classifyPaymentOrderRecovery(row) {
  const evidence = []
  const orderId = String(norm(row, 'order_id', 'orderId')).trim()
  const recoveryState = String(norm(row, 'recovery_state', 'recoveryState')).toUpperCase()
  const txnStatus = String(norm(row, 'status', 'status')).toLowerCase()
  const subTxn = String(norm(row, 'sub_transaction_id', 'subTransactionId')).trim()
  const subStatus = String(norm(row, 'sub_status', 'subStatus')).toLowerCase()
  const subExpires = parseDate(norm(row, 'sub_expires_at', 'subExpiresAt'))
  const adminRevokedAt = norm(row, 'admin_revoked_at', 'adminRevokedAt')
  const adminRevokedTxn = String(norm(row, 'admin_revoked_transaction_id', 'adminRevokedTransactionId')).trim()
  const supersedingOrderId = String(norm(row, 'superseding_order_id', 'supersedingOrderId')).trim()
  const moved = parseMovedTransactionId(subTxn)

  const finish = (recoveryClass, recoveryReason, extraEvidence = []) => {
    const recoveryLabel = RECOVERY_LABEL[recoveryClass] ?? recoveryClass
    let recoverySeverity = RECOVERY_SEVERITY.neutral
    let recoveryActionable = false

    switch (recoveryClass) {
      case RECOVERY_CLASS.ALREADY_ACTIVE:
      case RECOVERY_CLASS.ACTIVATED_HISTORICAL:
        recoverySeverity = RECOVERY_SEVERITY.success
        break
      case RECOVERY_CLASS.HAMISHA_TRANSFER:
      case RECOVERY_CLASS.SYSTEM_MIGRATION:
      case RECOVERY_CLASS.SUPERSEDED_STACKED:
      case RECOVERY_CLASS.MANUAL_GRANT_OVERRIDE:
        recoverySeverity = RECOVERY_SEVERITY.info
        break
      case RECOVERY_CLASS.EXPIRED:
        recoverySeverity = RECOVERY_SEVERITY.neutral
        break
      case RECOVERY_CLASS.ADMIN_REVOKED:
        recoverySeverity = RECOVERY_SEVERITY.warning
        break
      case RECOVERY_CLASS.TRUE_UNRESOLVED:
        recoverySeverity = RECOVERY_SEVERITY.danger
        recoveryActionable = true
        break
      case RECOVERY_CLASS.NEEDS_REVIEW:
        recoverySeverity = RECOVERY_SEVERITY.warning
        recoveryActionable = true
        break
      case RECOVERY_CLASS.PENDING_PROVIDER:
        recoverySeverity = RECOVERY_SEVERITY.warning
        break
      case RECOVERY_CLASS.FAILED_PROVIDER:
      case RECOVERY_CLASS.RECOVERY_REJECTED:
        recoverySeverity = RECOVERY_SEVERITY.danger
        break
      case RECOVERY_CLASS.MANUALLY_RECOVERED:
        recoverySeverity = RECOVERY_SEVERITY.success
        break
      default:
        break
    }

    return {
      recoveryClass,
      recoveryLabel,
      recoveryReason,
      recoverySeverity,
      recoveryActionable,
      recoveryEvidence: [...evidence, ...extraEvidence],
      recoveryHint: recoveryLabel,
    }
  }

  if (recoveryState === 'MANUALLY_APPROVED') {
    evidence.push('recovery_state=MANUALLY_APPROVED')
    return finish(RECOVERY_CLASS.MANUALLY_RECOVERED, 'Admin manual recovery approved on this order')
  }
  if (recoveryState === 'RECOVERY_REJECTED') {
    evidence.push('recovery_state=RECOVERY_REJECTED')
    return finish(RECOVERY_CLASS.RECOVERY_REJECTED, 'Recovery explicitly rejected for this order')
  }

  if (subTxnIsActiveAnchor(row)) {
    evidence.push('sub.transaction_id=order_id', 'sub.status=active', 'sub.expires_at>now')
    return finish(RECOVERY_CLASS.ALREADY_ACTIVE, 'This order is the current live entitlement anchor')
  }

  if (txnStatus === 'pending') {
    evidence.push('txn.status=pending')
    return finish(RECOVERY_CLASS.PENDING_PROVIDER, 'Payment pending at provider')
  }
  if (txnStatus === 'failed') {
    evidence.push('txn.status=failed')
    return finish(RECOVERY_CLASS.FAILED_PROVIDER, 'Payment failed at provider')
  }
  if (txnStatus !== 'completed') {
    evidence.push(`txn.status=${txnStatus || 'unknown'}`)
    return finish(RECOVERY_CLASS.NEEDS_REVIEW, `Unexpected transaction status: ${txnStatus || 'unknown'}`)
  }

  evidence.push('txn.status=completed')

  const revokedForOrder =
    (adminRevokedAt != null && adminRevokedAt !== '') &&
    (adminRevokedTxn === orderId || (!adminRevokedTxn && subTxn === orderId))
  const subRevoked = subStatus === 'revoked'

  if (revokedForOrder || (subRevoked && (adminRevokedTxn === orderId || subTxn === orderId))) {
    evidence.push('admin_revoked_at', adminRevokedTxn ? `admin_revoked_transaction_id=${adminRevokedTxn}` : 'sub.status=revoked')
    return finish(RECOVERY_CLASS.ADMIN_REVOKED, 'Subscription entitlement was explicitly revoked by admin')
  }

  if (hasCausalHamishaTransfer(row, orderId)) {
    const targetId = String(norm(row, 'hamisha_target_device_id', 'hamishaTargetDeviceId')).trim()
    evidence.push(`hamisha_transfer_id=${norm(row, 'hamisha_transfer_id', 'hamishaTransferId')}`)
    if (targetId) evidence.push(`hamisha_target_device_id=${targetId.slice(0, 16)}`)
    return finish(
      RECOVERY_CLASS.HAMISHA_TRANSFER,
      'Completed device-to-device Hamisha transfer moved entitlement anchored by this order',
    )
  }

  if (hasCausalSystemMigration(subTxn, orderId)) {
    evidence.push(`moved_marker_embeds_order=${orderId}`)
    if (moved.sourceDeviceId) evidence.push(`moved_source_device=${moved.sourceDeviceId.slice(0, 16)}`)
    return finish(
      RECOVERY_CLASS.SYSTEM_MIGRATION,
      'Automatic system recovery relocated entitlement anchored by this order',
    )
  }

  if (moved.isMoved && !moved.malformed && moved.embeddedTransactionId && moved.embeddedTransactionId !== orderId) {
    evidence.push(`moved_marker_embeds_other=${moved.embeddedTransactionId.slice(0, 32)}`)
    return finish(
      RECOVERY_CLASS.SUPERSEDED_STACKED,
      'Device subscription migrated to a different anchor order; this historical order is superseded',
    )
  }

  if (subTxn.startsWith('manual_grant:')) {
    evidence.push(`sub.transaction_id=${subTxn}`)
    return finish(RECOVERY_CLASS.MANUAL_GRANT_OVERRIDE, 'Manual grant is the current entitlement anchor')
  }

  if (
    supersedingOrderId &&
    subTxn === supersedingOrderId &&
    supersedingOrderId !== orderId
  ) {
    evidence.push(`superseding_order_id=${supersedingOrderId}`)
    return finish(RECOVERY_CLASS.SUPERSEDED_STACKED, 'A later completed payment became the subscription anchor')
  }

  if (subTxn === orderId && subExpires != null && subExpires.getTime() <= Date.now()) {
    evidence.push('sub.transaction_id=order_id', 'sub.expires_at<=now')
    return finish(RECOVERY_CLASS.EXPIRED, 'This order activated entitlement that later expired naturally')
  }

  if (isStrictUnresolvedCompletedOrder(row)) {
    evidence.push('strict_unresolved:sub.transaction_id=order_id', `sub.status=${subStatus || 'unknown'}`)
    return finish(
      RECOVERY_CLASS.TRUE_UNRESOLVED,
      'Completed payment bound to subscription row that is not active (strict unresolved)',
    )
  }

  if (hasActivationEvidence(row)) {
    evidence.push('activation_payload_or_recovery_audit')
    return finish(RECOVERY_CLASS.ACTIVATED_HISTORICAL, 'Activation evidence exists; order is no longer the current anchor')
  }

  if (supersedingOrderId && supersedingOrderId !== orderId) {
    evidence.push(`later_completed_order=${supersedingOrderId}`)
    return finish(RECOVERY_CLASS.SUPERSEDED_STACKED, 'Later completed order exists on same device')
  }

  if (moved.isMoved && moved.malformed) {
    evidence.push('moved_marker_malformed')
    return finish(RECOVERY_CLASS.NEEDS_REVIEW, 'Malformed moved:* subscription marker without provable order causality')
  }

  evidence.push('insufficient_lifecycle_evidence')
  return finish(RECOVERY_CLASS.NEEDS_REVIEW, 'Completed payment without provable lifecycle classification')
}

/**
 * Owner-facing Payment Orders display mapping.
 * SYSTEM_MIGRATION is preserved internally as recoveryDiagnosticClass; owner UI shows Already Active.
 * @param {ReturnType<typeof classifyPaymentOrderRecovery>} recovery
 */
export function mapOwnerFacingRecovery(recovery) {
  const diagnosticClass = recovery.recoveryClass
  if (diagnosticClass === RECOVERY_CLASS.SYSTEM_MIGRATION) {
    const alreadyActive = RECOVERY_LABEL[RECOVERY_CLASS.ALREADY_ACTIVE]
    return {
      ...recovery,
      recoveryDiagnosticClass: diagnosticClass,
      recoveryLabel: alreadyActive,
      recoveryHint: alreadyActive,
      recoverySeverity: RECOVERY_SEVERITY.success,
      recoveryActionable: false,
    }
  }
  return { ...recovery, recoveryDiagnosticClass: diagnosticClass }
}
