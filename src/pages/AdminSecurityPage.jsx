import { useCallback, useEffect, useMemo, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import Topbar from '../components/Topbar'
import SecurityPinModal from '../components/SecurityPinModal'
import AdminSecurityOtpModal from '../components/AdminSecurityOtpModal'
import AdminSecurityConfirmModal from '../components/AdminSecurityConfirmModal'
import { useToast } from '../context/ToastContext.jsx'
import {
  ApiError,
  clearAdminSecurityGateToken,
  deleteAdminTrustedDevice,
  getAdminAuthDevices,
  getAdminSecurityGateToken,
  postAdminDeviceBlock,
  postAdminDeviceForceOtp,
  postAdminDeviceRevoke,
  postAdminDeviceUnblock,
  postAdminSecurityDestructiveExecute,
  postAdminSecurityDestructiveResendOtp,
  postAdminSecurityDestructiveStart,
  postAdminSecurityResendOtp,
  postAdminSecurityVerifyOtp,
  postAdminSecurityVerifyPin,
  setAdminSecurityGateToken,
  syncStreamUrl,
} from '../lib/api'
import { formatAdminDateTime } from '../lib/formatAdminDateTime'

function pick(row, ...keys) {
  for (const k of keys) {
    const v = row?.[k]
    if (v != null && String(v).trim() !== '') return v
  }
  return null
}

function deviceStatus(row) {
  const raw = String(
    pick(row, 'status', 'derived_status', 'derivedStatus') || '',
  )
    .trim()
    .toUpperCase()
  if (raw === 'ACTIVE' || raw === 'TRUSTED') return 'ACTIVE'
  if (raw === 'NEW' || raw === 'BLOCKED' || raw === 'REVOKED') return raw
  if (row?.revokedAt || row?.revoked_at || row?.revoked) return 'REVOKED'
  if (row?.blocked) return 'BLOCKED'
  if (row?.forceOtpNext || row?.force_otp_next) return 'NEW'
  if (row?.trusted) return 'ACTIVE'
  return 'NEW'
}

function statusBadgeLabel(status) {
  if (status === 'ACTIVE') return 'ACTIVE / TRUSTED'
  return status
}

function statusBadgeClass(status) {
  switch (status) {
    case 'ACTIVE':
      return 'bg-emerald-900/50 text-emerald-200 ring-emerald-500/40'
    case 'NEW':
      return 'bg-amber-900/40 text-amber-100 ring-amber-500/40'
    case 'BLOCKED':
      return 'bg-rose-900/50 text-rose-100 ring-rose-500/40'
    case 'REVOKED':
      return 'bg-slate-800 text-slate-300 ring-slate-600/50'
    default:
      return 'bg-slate-800 text-slate-200 ring-slate-600/50'
  }
}

function deviceLocation(row) {
  const city = pick(row, 'city')
  const region = pick(row, 'region', 'regionName')
  const country = pick(row, 'country', 'countryCode', 'country_code')
  const parts = [city, region, country].filter(Boolean).map((x) => String(x).trim())
  return parts.length ? parts.join(', ') : '—'
}

function deviceIp(row) {
  return pick(row, 'ip', 'ipAddress', 'ip_address') || '—'
}

function DeviceActions({ row, busy, pinBusy, onBlock, onUnblock, onForceOtp, onRevoke, onDelete }) {
  const st = deviceStatus(row)
  const b = busy
  return (
    <div className="flex flex-wrap gap-1">
      {st !== 'BLOCKED' && st !== 'REVOKED' ? (
        <button
          type="button"
          disabled={b || pinBusy}
          onClick={onBlock}
          className="rounded-md bg-rose-600/90 px-2 py-1 text-[11px] font-bold text-white hover:bg-rose-500 disabled:opacity-40"
        >
          BLOCK
        </button>
      ) : st === 'BLOCKED' ? (
        <button
          type="button"
          disabled={b || pinBusy}
          onClick={onUnblock}
          className="rounded-md bg-emerald-700/90 px-2 py-1 text-[11px] font-bold text-white hover:bg-emerald-600 disabled:opacity-40"
        >
          UNBLOCK
        </button>
      ) : null}
      <button
        type="button"
        disabled={b || st === 'BLOCKED' || st === 'REVOKED' || pinBusy}
        onClick={onForceOtp}
        className="rounded-md border border-amber-600/60 bg-amber-950/40 px-2 py-1 text-[11px] font-bold text-amber-100 hover:bg-amber-900/40 disabled:opacity-40"
      >
        FORCE OTP
      </button>
      <button
        type="button"
        disabled={b || pinBusy || st === 'REVOKED'}
        onClick={onRevoke}
        className="rounded-md border border-slate-600 px-2 py-1 text-[11px] font-bold text-slate-200 hover:bg-slate-800 disabled:opacity-40"
      >
        REVOKE
      </button>
      <button
        type="button"
        disabled={b || pinBusy}
        onClick={onDelete}
        className="rounded-md border border-rose-500/50 bg-rose-950/50 px-2 py-1 text-[11px] font-bold text-rose-100 hover:bg-rose-900/40 disabled:opacity-40"
      >
        DELETE
      </button>
    </div>
  )
}

export default function AdminSecurityPage() {
  const { showToast } = useToast()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)

  const [pageUnlocked, setPageUnlocked] = useState(() => !!getAdminSecurityGateToken())
  const [pinModal, setPinModal] = useState(null)
  const pinModalKind = pinModal?.kind ?? null

  const [otpModalOpen, setOtpModalOpen] = useState(false)
  const [challengeToken, setChallengeToken] = useState('')
  const [maskedEmail, setMaskedEmail] = useState('')
  const [resendAvailableAt, setResendAvailableAt] = useState('')
  const [otpError, setOtpError] = useState('')
  const [otpBusy, setOtpBusy] = useState(false)

  const [pinError, setPinError] = useState('')
  const [pinBusy, setPinBusy] = useState(false)

  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [pendingDestructive, setPendingDestructive] = useState(null)
  const [destructiveOtpOpen, setDestructiveOtpOpen] = useState(false)
  const [destructiveChallengeToken, setDestructiveChallengeToken] = useState('')
  const [destructiveMaskedEmail, setDestructiveMaskedEmail] = useState('')
  const [destructiveResendAt, setDestructiveResendAt] = useState('')
  const [destructiveOtpError, setDestructiveOtpError] = useState('')
  const [destructiveBusy, setDestructiveBusy] = useState(false)
  const [confirmBusy, setConfirmBusy] = useState(false)

  const allSelected = useMemo(
    () => rows.length > 0 && rows.every((r) => selectedIds.has(r.id)),
    [rows, selectedIds],
  )

  const trustedCount = useMemo(
    () => rows.filter((r) => deviceStatus(r) === 'ACTIVE').length,
    [rows],
  )

  const load = useCallback(async () => {
    const isFirst = rows.length === 0
    if (isFirst) setLoading(true)
    try {
      const out = await getAdminAuthDevices()
      setRows(Array.isArray(out?.devices) ? out.devices : [])
    } catch (e) {
      if (e instanceof ApiError && e.status === 403 && e.body?.code === 'SECURITY_GATE_REQUIRED') {
        clearAdminSecurityGateToken()
        setPageUnlocked(false)
        setOtpModalOpen(false)
        setChallengeToken('')
        setRows([])
      } else {
        showToast('error', e?.message || 'Haikuwezekana kupakia vifaa')
      }
    } finally {
      setLoading(false)
    }
  }, [showToast, rows.length])

  useEffect(() => {
    if (pageUnlocked) void load()
  }, [pageUnlocked, load])

  useEffect(() => {
    if (!pageUnlocked) return undefined
    const es = new EventSource(syncStreamUrl(['config']))
    const onLogs = () => {
      showToast('info', 'Security logs updated (SSE)')
    }
    es.addEventListener('security_logs_changed', onLogs)
    return () => es.close()
  }, [pageUnlocked, showToast])

  useEffect(() => {
    if (!pageUnlocked && !otpModalOpen) {
      setPinModal({ kind: 'gate' })
      setPinError('')
    }
  }, [pageUnlocked, otpModalOpen])

  async function handleGatePinSubmit(pin) {
    setPinBusy(true)
    setPinError('')
    try {
      const out = await postAdminSecurityVerifyPin(pin)
      setChallengeToken(out.challengeToken || '')
      setMaskedEmail(out.maskedEmail || '')
      setResendAvailableAt(out.resendAvailableAt || '')
      setOtpError('')
      setPinModal(null)
      setOtpModalOpen(true)
      showToast('success', 'OTP imetumwa kwa barua pepe ya admin')
    } catch (e) {
      setPinError(e?.message || 'PIN si sahihi')
      showToast('error', e?.message || 'PIN si sahihi')
    } finally {
      setPinBusy(false)
    }
  }

  async function handleOtpSubmit(code) {
    if (!challengeToken) return
    setOtpBusy(true)
    setOtpError('')
    try {
      const out = await postAdminSecurityVerifyOtp({ challengeToken, otp: code })
      setAdminSecurityGateToken(out.gateToken)
      setOtpModalOpen(false)
      setChallengeToken('')
      setPageUnlocked(true)
      showToast('success', 'Umeidhinishwa')
    } catch (e) {
      const msg = e?.message || 'OTP si sahihi'
      setOtpError(msg)
      showToast('error', msg)
    } finally {
      setOtpBusy(false)
    }
  }

  async function handleOtpResend() {
    if (!challengeToken) return
    setOtpBusy(true)
    setOtpError('')
    try {
      const out = await postAdminSecurityResendOtp({ challengeToken })
      setMaskedEmail(out.maskedEmail || maskedEmail)
      setResendAvailableAt(out.resendAvailableAt || '')
      showToast('success', 'OTP imetumwa tena')
    } catch (e) {
      setOtpError(e?.message || 'Haikuwezekana kutuma OTP tena')
    } finally {
      setOtpBusy(false)
    }
  }

  function closeOtpFlow() {
    if (otpBusy) return
    setOtpModalOpen(false)
    setChallengeToken('')
    setOtpError('')
    setPinModal({ kind: 'gate' })
  }

  function lockPage() {
    clearAdminSecurityGateToken()
    setPageUnlocked(false)
    setPinModal(null)
    setOtpModalOpen(false)
    setChallengeToken('')
  }

  function toggleSelectAll() {
    if (allSelected) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(rows.map((r) => r.id)))
    }
  }

  function toggleRowSelected(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function requestDeleteSelected() {
    const ids = rows.filter((r) => selectedIds.has(r.id)).map((r) => r.id)
    if (ids.length === 0) {
      showToast('error', 'Chagua angalau kifaa kimoja')
      return
    }
    setPendingDestructive({
      action: 'revoke_devices',
      deviceIds: ids,
      title: `Revoke ${ids.length} selected device(s)?`,
      message: `Revoke ${ids.length} selected trusted device(s). Sessions and credentials are invalidated. Records stay as REVOKED for audit.`,
      requireTyped: false,
    })
    setConfirmOpen(true)
  }

  function requestHardDeleteSelected() {
    const ids = rows.filter((r) => selectedIds.has(r.id)).map((r) => r.id)
    if (ids.length === 0) {
      showToast('error', 'Chagua angalau kifaa kimoja')
      return
    }
    setPendingDestructive({
      action: 'delete_devices',
      deviceIds: ids,
      title: `Permanently delete ${ids.length} selected device(s)?`,
      message: `Permanently delete ${ids.length} selected device record(s) from the database after invalidating credentials/sessions. This cannot be undone.`,
      requireTyped: true,
    })
    setConfirmOpen(true)
  }

  function requestDeleteAllLogs() {
    setPendingDestructive({
      action: 'delete_all_security_logs',
      title: 'Delete ALL security sessions/logs permanently?',
      message:
        'Permanently deletes all security_events, admin security audit events, and admin session rows from the database. Trusted devices are not removed. This cannot be undone.',
      requireTyped: true,
    })
    setConfirmOpen(true)
  }

  function closeDestructiveFlow() {
    setConfirmOpen(false)
    setPendingDestructive(null)
    setDestructiveOtpOpen(false)
    setDestructiveChallengeToken('')
    setDestructiveOtpError('')
    setConfirmBusy(false)
    setDestructiveBusy(false)
  }

  function onConfirmDestructive() {
    setConfirmOpen(false)
    setPinError('')
    setPinModal({ kind: 'destructive' })
  }

  async function handleDestructivePinSubmit(pin) {
    if (!pendingDestructive) return
    setPinBusy(true)
    setPinError('')
    try {
      const out = await postAdminSecurityDestructiveStart({
        securityPin: pin,
        action: pendingDestructive.action,
        deviceIds: pendingDestructive.deviceIds,
      })
      setDestructiveChallengeToken(out.challengeToken || '')
      setDestructiveMaskedEmail(out.maskedEmail || '')
      setDestructiveResendAt(out.resendAvailableAt || '')
      setDestructiveOtpError('')
      setPinModal(null)
      setDestructiveOtpOpen(true)
      showToast('success', 'OTP imetumwa kwa uthibitishaji wa hatua hii')
    } catch (e) {
      setPinError(e?.message || 'PIN si sahihi')
    } finally {
      setPinBusy(false)
    }
  }

  async function handleDestructiveOtpResend() {
    if (!destructiveChallengeToken) return
    setDestructiveBusy(true)
    setDestructiveOtpError('')
    try {
      const out = await postAdminSecurityDestructiveResendOtp({
        challengeToken: destructiveChallengeToken,
      })
      setDestructiveMaskedEmail(out.maskedEmail || destructiveMaskedEmail)
      setDestructiveResendAt(out.resendAvailableAt || '')
      showToast('success', 'OTP imetumwa tena')
    } catch (e) {
      setDestructiveOtpError(e?.message || 'Haikuwezekana kutuma OTP tena')
    } finally {
      setDestructiveBusy(false)
    }
  }

  async function handleDestructiveOtpSubmit(code) {
    if (!destructiveChallengeToken || !pendingDestructive) return
    setDestructiveBusy(true)
    setDestructiveOtpError('')
    try {
      const run = (confirmCurrent) =>
        postAdminSecurityDestructiveExecute({
          challengeToken: destructiveChallengeToken,
          otp: code,
          confirmCurrentDevice: confirmCurrent,
        })
      let out
      try {
        out = await run(false)
      } catch (e) {
        if (!(e instanceof ApiError)) throw e
        const errCode = e.body && typeof e.body === 'object' ? e.body.code : undefined
        if (e.status === 409 && errCode === 'CONFIRM_CURRENT_DEVICE') {
          const ok = window.confirm(
            'Baadhi ya vifaa vilivyochaguliwa ni kifaa unachokitumia sasa. Endelea?',
          )
          if (!ok) return
          out = await run(true)
        } else {
          throw e
        }
      }
      if (!out || out.ok === false) {
        throw new Error(out?.error || 'Backend did not confirm the action')
      }
      const affected = Number(out.affected ?? out.deleted ?? 0)
      if (affected <= 0) {
        throw new Error('No records were affected — nothing deleted/revoked')
      }
      const successMsg =
        pendingDestructive.action === 'delete_all_security_logs'
          ? `Permanently deleted ${affected} session/log row(s)`
          : pendingDestructive.action === 'revoke_devices'
            ? `Revoked ${affected} device(s)`
            : `Permanently deleted ${affected} device(s)`
      showToast('success', successMsg)
      setSelectedIds(new Set())
      closeDestructiveFlow()
      await load()
    } catch (e) {
      const msg = e?.message || 'Imeshindikana'
      setDestructiveOtpError(msg)
      showToast('error', msg)
    } finally {
      setDestructiveBusy(false)
    }
  }

  function openActionModal(run) {
    setPinError('')
    setPinModal({ kind: 'action', run })
  }

  async function handleActionPinSubmit(pin) {
    if (pinModal?.kind !== 'action' || !pinModal.run) return
    setPinBusy(true)
    setPinError('')
    try {
      await executeWithCurrentDeviceConfirm(pin, pinModal.run)
      showToast('success', 'Imefanikiwa')
      setPinModal(null)
      await load()
    } catch (e) {
      const msg = e?.message || 'Imeshindikana'
      setPinError(msg)
      showToast('error', msg)
    } finally {
      setPinBusy(false)
      setBusyId(null)
    }
  }

  /** @param {(pin: string, confirmCurrent: boolean) => Promise<void>} run */
  async function executeWithCurrentDeviceConfirm(pin, run) {
    try {
      await run(pin, false)
    } catch (e) {
      if (!(e instanceof ApiError)) throw e
      const code = e.body && typeof e.body === 'object' ? e.body.code : undefined
      if (e.status === 409 && code === 'CONFIRM_CURRENT_DEVICE') {
        const ok = window.confirm(
          'Hatua hii inahusu kifaa unachokitumia sasa kutumia ADMIN. Unaweza kujitenga na akaunti. Endelea?',
        )
        if (!ok) return
        await run(pin, true)
        return
      }
      throw e
    }
  }

  function confirmThen(message, run) {
    if (!window.confirm(message)) {
      setBusyId(null)
      return
    }
    openActionModal(run)
  }

  function renderDeviceMeta(r) {
    const st = deviceStatus(r)
    const deviceName = pick(r, 'deviceName', 'device_name') || '—'
    const deviceType = pick(r, 'deviceType', 'device_type') || '—'
    const osName = pick(r, 'osName', 'os_name') || '—'
    const browser = pick(r, 'browser') || '—'
    const firstSeen = formatAdminDateTime(pick(r, 'firstSeen', 'first_seen', 'createdAt', 'created_at'))
    const lastActive = formatAdminDateTime(
      pick(r, 'lastActive', 'last_active', 'lastUsedAt', 'last_used_at'),
    )
    const lastLogin = formatAdminDateTime(pick(r, 'lastLogin', 'last_login', 'lastLoginAt', 'last_login_at'))
    return {
      st,
      deviceName,
      deviceType,
      osName,
      browser,
      firstSeen,
      lastActive,
      lastLogin,
      location: deviceLocation(r),
      ip: deviceIp(r),
    }
  }

  function deviceActionHandlers(r) {
    return {
      onBlock: () => {
        setBusyId(r.id)
        confirmThen('Zuia (block) kifaa hiki?', (pin, confirmCurrent) =>
          postAdminDeviceBlock(r.id, { securityPin: pin, confirmCurrentDevice: confirmCurrent }),
        )
      },
      onUnblock: () => {
        setBusyId(r.id)
        confirmThen('Ondoa kizuizi (unblock) cha kifaa hiki?', (pin) =>
          postAdminDeviceUnblock(r.id, { securityPin: pin }),
        )
      },
      onForceOtp: () => {
        setBusyId(r.id)
        confirmThen('Lazimisha OTP kwenye login ijayo kwa kifaa hiki?', (pin, confirmCurrent) =>
          postAdminDeviceForceOtp(r.id, {
            securityPin: pin,
            confirmCurrentDevice: confirmCurrent,
          }),
        )
      },
      onRevoke: () => {
        setBusyId(r.id)
        confirmThen(
          'Revoke this device? Sessions and credentials are invalidated; status becomes REVOKED.',
          (pin, confirmCurrent) =>
            postAdminDeviceRevoke(r.id, {
              securityPin: pin,
              confirmCurrentDevice: confirmCurrent,
            }),
        )
      },
      onDelete: () => {
        setBusyId(r.id)
        confirmThen(
          'Permanently DELETE this device record from the database after invalidating credentials?',
          (pin, confirmCurrent) =>
            deleteAdminTrustedDevice(r.id, {
              securityPin: pin,
              confirmCurrentDevice: confirmCurrent,
            }),
        )
      },
    }
  }

  return (
    <>
      <SecurityPinModal
        open={pinModalKind === 'gate'}
        title="Ingiza Security PIN"
        errorText={pinError}
        busy={pinBusy}
        onClose={() => {
          if (!pinBusy) setPinModal(null)
        }}
        onSubmit={handleGatePinSubmit}
      />
      <AdminSecurityOtpModal
        open={otpModalOpen}
        maskedEmail={maskedEmail}
        resendAvailableAt={resendAvailableAt}
        errorText={otpError}
        busy={otpBusy}
        onClose={closeOtpFlow}
        onSubmit={handleOtpSubmit}
        onResend={handleOtpResend}
      />
      <SecurityPinModal
        open={pinModalKind === 'action'}
        title="Ingiza Security PIN"
        errorText={pinError}
        busy={pinBusy}
        onClose={() => {
          if (!pinBusy) {
            setPinModal(null)
            setBusyId(null)
          }
        }}
        onSubmit={handleActionPinSubmit}
      />
      <SecurityPinModal
        open={pinModalKind === 'destructive'}
        title="PIN kwa hatua hatari"
        errorText={pinError}
        busy={pinBusy}
        onClose={() => {
          if (!pinBusy) {
            setPinModal(null)
            closeDestructiveFlow()
          }
        }}
        onSubmit={handleDestructivePinSubmit}
      />
      <AdminSecurityOtpModal
        open={destructiveOtpOpen}
        maskedEmail={destructiveMaskedEmail}
        resendAvailableAt={destructiveResendAt}
        errorText={destructiveOtpError}
        busy={destructiveBusy}
        onClose={() => {
          if (!destructiveBusy) closeDestructiveFlow()
        }}
        onSubmit={handleDestructiveOtpSubmit}
        onResend={handleDestructiveOtpResend}
      />
      <AdminSecurityConfirmModal
        open={confirmOpen}
        title={pendingDestructive?.title ?? ''}
        message={pendingDestructive?.message ?? ''}
        requireTyped={pendingDestructive?.requireTyped === true}
        busy={confirmBusy}
        onClose={() => {
          if (!confirmBusy) closeDestructiveFlow()
        }}
        onConfirm={onConfirmDestructive}
      />

      <Topbar />
      <main className="mt-6 flex min-h-0 flex-1 flex-col gap-6">
        {!pageUnlocked ? (
          <div className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-slate-700/60 bg-slate-950/40 py-24 ring-1 ring-white/[0.04]">
            <ShieldCheck className="h-12 w-12 text-emerald-400/80" aria-hidden />
            <div className="max-w-md text-center">
              <h2 className="text-xl font-bold text-white">Admin Security imefungwa</h2>
              <p className="mt-2 text-sm text-slate-400">
                Thibiti PIN, kisha OTP kutoka kwa barua pepe ya admin, ili kuona au kuhariri vifaa
                vinavyoaminiwa.
              </p>
            </div>
            <button
              type="button"
              className="rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-6 py-3 text-sm font-bold text-slate-950 shadow-lg"
              onClick={() => {
                setPinError('')
                setPinModal({ kind: 'gate' })
              }}
            >
              Ingiza PIN
            </button>
          </div>
        ) : (
          <>
            <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-emerald-500/30 bg-emerald-500/10">
                  <ShieldCheck className="h-5 w-5 text-emerald-300" aria-hidden />
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-400/90">
                    Security
                  </p>
                  <h1 className="text-2xl font-bold text-white sm:text-3xl">ADMIN SECURITY</h1>
                  <p className="mt-1 text-sm text-slate-400">
                    Trusted devices · {trustedCount} ACTIVE/TRUSTED · {rows.length} total
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={loading || selectedIds.size === 0 || destructiveBusy}
                  onClick={requestDeleteSelected}
                  className="rounded-xl border border-rose-500/40 bg-rose-950/40 px-4 py-2 text-sm font-semibold text-rose-100 hover:bg-rose-900/40 disabled:opacity-40"
                >
                  Revoke Selected ({selectedIds.size})
                </button>
                <button
                  type="button"
                  disabled={loading || selectedIds.size === 0 || destructiveBusy}
                  onClick={requestHardDeleteSelected}
                  className="rounded-xl border border-rose-500/50 bg-rose-950/50 px-4 py-2 text-sm font-semibold text-rose-100 hover:bg-rose-900/50 disabled:opacity-40"
                >
                  Delete Selected ({selectedIds.size})
                </button>
                <button
                  type="button"
                  disabled={loading || destructiveBusy}
                  onClick={requestDeleteAllLogs}
                  className="rounded-xl border border-rose-500/40 bg-rose-950/40 px-4 py-2 text-sm font-semibold text-rose-100 hover:bg-rose-900/40 disabled:opacity-40"
                >
                  Delete All Sessions/Logs
                </button>
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => void load()}
                  className="rounded-xl border border-slate-600 bg-slate-900/80 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                >
                  Onyesha upya
                </button>
                <button
                  type="button"
                  onClick={lockPage}
                  className="rounded-xl border border-slate-600 bg-slate-900/80 px-4 py-2 text-sm font-semibold text-slate-300 hover:bg-slate-800"
                >
                  Funga ukurasa
                </button>
              </div>
            </header>

            {/* Mobile cards */}
            <section className="flex flex-col gap-3 lg:hidden">
              {loading && rows.length === 0 ? (
                <p className="py-8 text-center text-slate-500">Inapakia…</p>
              ) : rows.length === 0 ? (
                <p className="py-8 text-center text-slate-500">Hakuna vifaa bado.</p>
              ) : (
                rows.map((r) => {
                  const m = renderDeviceMeta(r)
                  const actions = deviceActionHandlers(r)
                  return (
                    <article
                      key={r.id}
                      className="rounded-2xl border border-slate-700/60 bg-slate-950/50 p-4 ring-1 ring-white/[0.04]"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <input
                              type="checkbox"
                              checked={selectedIds.has(r.id)}
                              onChange={() => toggleRowSelected(r.id)}
                              className="mt-0.5 h-4 w-4 rounded border-slate-500"
                              aria-label={`Chagua ${m.deviceName}`}
                            />
                            <h3 className="truncate font-semibold text-slate-100">{m.deviceName}</h3>
                            {r.isCurrentDevice ? (
                              <span className="rounded-md bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-200 ring-1 ring-amber-500/40">
                                CURRENT
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-1 text-xs text-slate-400">
                            {m.deviceType} · {m.osName}
                          </p>
                        </div>
                        <span
                          className={`shrink-0 rounded-lg px-2 py-0.5 text-[10px] font-bold ring-1 ${statusBadgeClass(m.st)}`}
                        >
                          {statusBadgeLabel(m.st)}
                        </span>
                      </div>
                      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                        <div>
                          <dt className="text-slate-500">Browser</dt>
                          <dd className="truncate text-slate-300" title={m.browser}>
                            {m.browser}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-slate-500">IP</dt>
                          <dd className="font-mono text-slate-300">{m.ip}</dd>
                        </div>
                        <div className="col-span-2">
                          <dt className="text-slate-500">Location</dt>
                          <dd className="text-slate-300">{m.location}</dd>
                        </div>
                        <div>
                          <dt className="text-slate-500">First seen</dt>
                          <dd className="text-slate-300">{m.firstSeen}</dd>
                        </div>
                        <div>
                          <dt className="text-slate-500">Last active</dt>
                          <dd className="text-slate-300">{m.lastActive}</dd>
                        </div>
                        <div className="col-span-2">
                          <dt className="text-slate-500">Last login</dt>
                          <dd className="text-slate-300">{m.lastLogin}</dd>
                        </div>
                      </dl>
                      <div className="mt-3">
                        <DeviceActions
                          row={r}
                          busy={busyId === r.id}
                          pinBusy={pinBusy}
                          {...actions}
                        />
                      </div>
                    </article>
                  )
                })
              )}
            </section>

            {/* Desktop table */}
            <section className="hidden overflow-x-auto rounded-2xl border border-slate-700/60 bg-slate-950/40 ring-1 ring-white/[0.04] lg:block">
              <table className="min-w-[1180px] w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-700/60 bg-slate-900/60 text-xs uppercase tracking-wide text-slate-400">
                    <th className="w-10 px-3 py-3">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={toggleSelectAll}
                        aria-label="Chagua vyote"
                        className="h-4 w-4 rounded border-slate-500"
                      />
                    </th>
                    <th className="px-3 py-3 font-semibold">Device</th>
                    <th className="px-3 py-3 font-semibold">Type / OS</th>
                    <th className="px-3 py-3 font-semibold">Browser</th>
                    <th className="px-3 py-3 font-semibold">IP</th>
                    <th className="px-3 py-3 font-semibold">Location</th>
                    <th className="px-3 py-3 font-semibold">First seen</th>
                    <th className="px-3 py-3 font-semibold">Last active</th>
                    <th className="px-3 py-3 font-semibold">Last login</th>
                    <th className="px-3 py-3 font-semibold">Status</th>
                    <th className="px-3 py-3 font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80">
                  {loading && rows.length === 0 ? (
                    <tr>
                      <td colSpan={11} className="px-3 py-10 text-center text-slate-500">
                        Inapakia…
                      </td>
                    </tr>
                  ) : rows.length === 0 ? (
                    <tr>
                      <td colSpan={11} className="px-3 py-10 text-center text-slate-500">
                        Hakuna vifaa bado.
                      </td>
                    </tr>
                  ) : (
                    rows.map((r) => {
                      const m = renderDeviceMeta(r)
                      const actions = deviceActionHandlers(r)
                      return (
                        <tr key={r.id} className="bg-slate-950/20 hover:bg-slate-900/40">
                          <td className="px-3 py-2.5">
                            <input
                              type="checkbox"
                              checked={selectedIds.has(r.id)}
                              onChange={() => toggleRowSelected(r.id)}
                              aria-label={`Chagua ${m.deviceName}`}
                              className="h-4 w-4 rounded border-slate-500"
                            />
                          </td>
                          <td className="px-3 py-2.5">
                            <span className="text-slate-200">{m.deviceName}</span>
                            {r.isCurrentDevice ? (
                              <span className="ml-2 rounded-md bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-200 ring-1 ring-amber-500/40">
                                CURRENT
                              </span>
                            ) : null}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-xs text-slate-400">
                            {m.deviceType} / {m.osName}
                          </td>
                          <td
                            className="max-w-[160px] truncate px-3 py-2.5 text-xs text-slate-400"
                            title={m.browser}
                          >
                            {m.browser}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs text-slate-400">
                            {m.ip}
                          </td>
                          <td
                            className="max-w-[140px] truncate px-3 py-2.5 text-xs text-slate-400"
                            title={m.location}
                          >
                            {m.location}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-slate-300">{m.firstSeen}</td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-slate-300">{m.lastActive}</td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-slate-300">{m.lastLogin}</td>
                          <td className="px-3 py-2.5">
                            <span
                              className={`rounded-lg px-2 py-0.5 text-[10px] font-bold ring-1 ${statusBadgeClass(m.st)}`}
                            >
                              {statusBadgeLabel(m.st)}
                            </span>
                          </td>
                          <td className="px-3 py-2.5">
                            <DeviceActions
                              row={r}
                              busy={busyId === r.id}
                              pinBusy={pinBusy}
                              {...actions}
                            />
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </section>
          </>
        )}
      </main>
    </>
  )
}
