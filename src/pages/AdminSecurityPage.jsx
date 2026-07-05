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
      action: 'delete_devices',
      deviceIds: ids,
      title: 'Futa vifaa vilivyochaguliwa',
      message: `Unaondoa vifaa ${ids.length} vinavyoaminiwa. Hatua hii haiwezi kutenduliwa.`,
      requireTyped: false,
    })
    setConfirmOpen(true)
  }

  function requestDeleteAllLogs() {
    setPendingDestructive({
      action: 'delete_all_security_logs',
      title: 'Futa rekodi zote za usalama',
      message:
        'Hii itafuta rekodi zote za security_events (logs/alerts). Haiathiri usajili wala vifaa vinavyoaminiwa.',
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
      showToast(
        'success',
        pendingDestructive.action === 'delete_all_security_logs'
          ? `Imefutwa rekodi ${out.deleted ?? 0}`
          : `Imeondolewa vifaa ${out.deleted ?? 0}`,
      )
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
      const code =
        e.body && typeof e.body === 'object' ? e.body.code : undefined
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
                  <p className="mt-1 text-sm text-slate-400">Vifaa vinavyoaminiwa · vizuiwi · OTP tena</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={loading || selectedIds.size === 0 || destructiveBusy}
                  onClick={requestDeleteSelected}
                  className="rounded-xl border border-rose-500/40 bg-rose-950/40 px-4 py-2 text-sm font-semibold text-rose-100 hover:bg-rose-900/40 disabled:opacity-40"
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

            <section className="overflow-x-auto rounded-2xl border border-slate-700/60 bg-slate-950/40 ring-1 ring-white/[0.04]">
              <table className="min-w-[980px] w-full border-collapse text-left text-sm">
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
                    <th className="px-3 py-3 font-semibold">Kifaa</th>
                    <th className="px-3 py-3 font-semibold">Browser</th>
                    <th className="px-3 py-3 font-semibold">IP</th>
                    <th className="px-3 py-3 font-semibold">Iliundwa</th>
                    <th className="px-3 py-3 font-semibold">Mwisho tumika</th>
                    <th className="px-3 py-3 font-semibold">Hali</th>
                    <th className="px-3 py-3 font-semibold">Vitendo</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80">
                  {loading && rows.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-3 py-10 text-center text-slate-500">
                        Inapakia…
                      </td>
                    </tr>
                  ) : rows.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-3 py-10 text-center text-slate-500">
                        Hakuna vifaa bado.
                      </td>
                    </tr>
                  ) : (
                    rows.map((r) => {
                      const st = r.blocked ? 'BLOCKED' : r.forceOtpNext ? 'OTP REQUIRED' : 'TRUSTED'
                      const b = busyId === r.id
                      return (
                        <tr key={r.id} className="bg-slate-950/20 hover:bg-slate-900/40">
                          <td className="px-3 py-2.5">
                            <input
                              type="checkbox"
                              checked={selectedIds.has(r.id)}
                              onChange={() => toggleRowSelected(r.id)}
                              aria-label={`Chagua ${r.deviceName || 'kifaa'}`}
                              className="h-4 w-4 rounded border-slate-500"
                            />
                          </td>
                          <td className="px-3 py-2.5">
                            <span className="text-slate-200">{r.deviceName || '—'}</span>
                            {r.isCurrentDevice ? (
                              <span className="ml-2 rounded-md bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-200 ring-1 ring-amber-500/40">
                                CURRENT
                              </span>
                            ) : null}
                          </td>
                          <td
                            className="max-w-[200px] truncate px-3 py-2.5 text-xs text-slate-400"
                            title={r.browser}
                          >
                            {r.browser || '—'}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs text-slate-400">
                            {r.ipAddress || '—'}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-slate-300">
                            {formatAdminDateTime(r.createdAt)}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-slate-300">
                            {formatAdminDateTime(r.lastUsedAt)}
                          </td>
                          <td className="px-3 py-2.5">
                            <span className="rounded-lg bg-slate-800 px-2 py-0.5 text-xs font-semibold text-slate-200 ring-1 ring-slate-600/50">
                              {st}
                            </span>
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="flex flex-wrap gap-1">
                              {!r.blocked ? (
                                <button
                                  type="button"
                                  disabled={b || pinBusy}
                                  onClick={() => {
                                    setBusyId(r.id)
                                    openActionModal((pin, confirmCurrent) =>
                                      postAdminDeviceBlock(r.id, { securityPin: pin, confirmCurrentDevice: confirmCurrent }),
                                    )
                                  }}
                                  className="rounded-md bg-rose-600/90 px-2 py-1 text-[11px] font-bold text-white hover:bg-rose-500 disabled:opacity-40"
                                >
                                  BLOCK
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  disabled={b || pinBusy}
                                  onClick={() => {
                                    setBusyId(r.id)
                                    openActionModal((pin) =>
                                      postAdminDeviceUnblock(r.id, { securityPin: pin }),
                                    )
                                  }}
                                  className="rounded-md bg-emerald-700/90 px-2 py-1 text-[11px] font-bold text-white hover:bg-emerald-600 disabled:opacity-40"
                                >
                                  UNBLOCK
                                </button>
                              )}
                              <button
                                type="button"
                                disabled={b || r.blocked || pinBusy}
                                onClick={() => {
                                  setBusyId(r.id)
                                  openActionModal((pin, confirmCurrent) =>
                                    postAdminDeviceForceOtp(r.id, {
                                      securityPin: pin,
                                      confirmCurrentDevice: confirmCurrent,
                                    }),
                                  )
                                }}
                                className="rounded-md border border-amber-600/60 bg-amber-950/40 px-2 py-1 text-[11px] font-bold text-amber-100 hover:bg-amber-900/40 disabled:opacity-40"
                              >
                                FORCE OTP
                              </button>
                              <button
                                type="button"
                                disabled={b || pinBusy}
                                onClick={() => {
                                  setBusyId(r.id)
                                  openActionModal((pin, confirmCurrent) =>
                                    deleteAdminTrustedDevice(r.id, {
                                      securityPin: pin,
                                      confirmCurrentDevice: confirmCurrent,
                                    }),
                                  )
                                }}
                                className="rounded-md border border-slate-600 px-2 py-1 text-[11px] font-bold text-slate-200 hover:bg-slate-800 disabled:opacity-40"
                              >
                                REMOVE
                              </button>
                            </div>
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

