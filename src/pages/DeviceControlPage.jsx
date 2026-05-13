import { useCallback, useEffect, useMemo, useState } from 'react'
import { ClipboardList, Hourglass, Settings, Zap } from 'lucide-react'
import FlashMessage from '../components/FlashMessage'
import SecurityPinModal from '../components/SecurityPinModal'
import Topbar from '../components/Topbar'
import { useDeviceSubscription } from '../context/DeviceSubscriptionContext.jsx'
import { useToast } from '../context/ToastContext.jsx'
import {
  getDeviceControlSettings,
  postAdminForceTransfer,
  postAdminForceTransferPhone,
  postManualSubscriptionBulkBlock,
  postManualSubscriptionBulkUnblock,
  postSubscriptionRecover,
  postSubscriptionRevoke,
  postTransferConfirm,
  postTransferRequest,
  putDeviceControlSettings,
  syncStreamUrl,
} from '../lib/api'
import { formatReadableDateTime } from '../lib/formatTxDisplay'

function newId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `dc-${Date.now()}`
}

function defaultDevice() {
  return {
    transferMode: 'confirmation',
    dailyLimit: 5,
    weeklyLimit: 15,
    cooldownMinutes: 60,
    pending: [],
    logs: [],
  }
}

function toSafeNonNegInt(v, fallback) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.floor(n)
}

function normalizeDeviceControlFromServer(s) {
  if (!s || typeof s !== 'object') throw new Error('Invalid settings response')
  const pendingRaw = Array.isArray(s.pending) ? s.pending : []
  const pending = pendingRaw.map((p) => ({
    id: String(p.id ?? ''),
    sourceDeviceId: String(p.sourceDeviceId ?? p.source_device_id ?? ''),
    deviceLabel: String(p.deviceLabel ?? p.device_label ?? ''),
    requestedAt: p.requestedAt ?? p.requested_at,
    status: String(p.status ?? ''),
  }))
  return {
    transferMode: String(s.transferMode || s.transfer_mode || 'confirmation') === 'manual' ? 'manual' : 'confirmation',
    dailyLimit: toSafeNonNegInt(s.dailyLimit ?? s.daily_limit, 5),
    weeklyLimit: toSafeNonNegInt(s.weeklyLimit ?? s.weekly_limit, 15),
    cooldownMinutes: toSafeNonNegInt(s.cooldownMinutes ?? s.cooldown_minutes, 60),
    pending,
    logs: Array.isArray(s.logs) ? s.logs : [],
  }
}

function inputClass() {
  return 'w-full rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-100 focus:border-amber-500/60 focus:outline-none focus:ring-2 focus:ring-amber-500/25'
}

const TABS = [
  { id: 'settings', label: 'Settings', icon: Settings },
  { id: 'pending', label: 'Recent Activity', icon: Hourglass },
  { id: 'logs', label: 'Logs', icon: ClipboardList },
  { id: 'force', label: 'Force Transfer', icon: Zap },
]

function DeviceControlPage() {
  const { showToast } = useToast()
  const {
    trackedDeviceId,
    trackedFingerprint,
    subscriptionState,
    trackSubscriptionDevice,
    refreshSubscriptionState,
    clearSubscription,
  } = useDeviceSubscription()
  const [cfg, setCfg] = useState(() => defaultDevice())
  const [draft, setDraft] = useState(() => ({
    transferMode: defaultDevice().transferMode,
    dailyLimit: defaultDevice().dailyLimit,
    weeklyLimit: defaultDevice().weeklyLimit,
    cooldownMinutes: defaultDevice().cooldownMinutes,
  }))
  const [tab, setTab] = useState('settings')
  const [flash, setFlash] = useState(null)
  const [forcePaymentPhone, setForcePaymentPhone] = useState('')
  const [forceSourceDeviceId, setForceSourceDeviceId] = useState('')
  const [forceTargetDeviceId, setForceTargetDeviceId] = useState('')
  const [runtimeDeviceId, setRuntimeDeviceId] = useState('')
  const [runtimeFingerprint, setRuntimeFingerprint] = useState('')
  const [requestSourceDeviceId, setRequestSourceDeviceId] = useState('')
  const [requestPaymentPhone, setRequestPaymentPhone] = useState('')
  const [requestTargetFingerprint, setRequestTargetFingerprint] = useState('')
  const [confirmCode, setConfirmCode] = useState('')
  const [confirmTargetDeviceId, setConfirmTargetDeviceId] = useState('')
  const [confirmTargetFingerprint, setConfirmTargetFingerprint] = useState('')
  const [revokeDeviceId, setRevokeDeviceId] = useState('')
  const [recoverDeviceId, setRecoverDeviceId] = useState('')
  const [recoverFingerprint, setRecoverFingerprint] = useState('')
  const [issuedTransfer, setIssuedTransfer] = useState(null)
  const [runtimeBusy, setRuntimeBusy] = useState('')

  const [pendingSel, setPendingSel] = useState(() => new Set())
  const [pendingBulkPin, setPendingBulkPin] = useState(null)
  const [pendingPinBusy, setPendingPinBusy] = useState(false)
  const [pendingPinErr, setPendingPinErr] = useState('')

  useEffect(() => {
    if (tab !== 'pending') setPendingSel(new Set())
  }, [tab])

  const allPendingChecked = useMemo(
    () => (cfg.pending || []).length > 0 && (cfg.pending || []).every((p) => pendingSel.has(p.id)),
    [cfg.pending, pendingSel],
  )

  async function submitPendingBulkPin(pin) {
    if (typeof pendingBulkPin !== 'function') return
    setPendingPinBusy(true)
    setPendingPinErr('')
    try {
      await pendingBulkPin(pin)
      setPendingBulkPin(null)
      showToast('success', 'Imefanikiwa')
      await loadCfg()
      setPendingSel(new Set())
    } catch (e) {
      const msg = e?.message || 'Imeshindikana'
      setPendingPinErr(msg)
      showToast('error', msg)
    } finally {
      setPendingPinBusy(false)
    }
  }

  const loadCfg = useCallback(async () => {
    try {
      const s = await getDeviceControlSettings()
      const hydrated = normalizeDeviceControlFromServer(s)
      setCfg(hydrated)
      setDraft({
        transferMode: hydrated.transferMode,
        dailyLimit: hydrated.dailyLimit,
        weeklyLimit: hydrated.weeklyLimit,
        cooldownMinutes: hydrated.cooldownMinutes,
      })
    } catch (e) {
      showToast('error', e?.message || 'Could not load device control')
    }
  }, [showToast])

  useEffect(() => {
    loadCfg()
  }, [loadCfg])

  useEffect(() => {
    const es = new EventSource(syncStreamUrl(['config']))
    const onRefresh = () => {
      void loadCfg()
    }
    es.addEventListener('transfer_requested', onRefresh)
    es.addEventListener('transfer_completed', onRefresh)
    es.addEventListener('transfer_rejected', onRefresh)
    es.addEventListener('subscription_revoked', onRefresh)
    es.addEventListener('app_settings_changed', onRefresh)
    es.addEventListener('device_control_changed', onRefresh)
    es.addEventListener('security_logs_changed', onRefresh)
    return () => es.close()
  }, [loadCfg])

  useEffect(() => {
    if (trackedDeviceId) setRuntimeDeviceId(trackedDeviceId)
    if (trackedFingerprint) setRuntimeFingerprint(trackedFingerprint)
  }, [trackedDeviceId, trackedFingerprint])

  const dirty = useMemo(
    () =>
      draft.transferMode !== cfg.transferMode ||
      Number(draft.dailyLimit) !== cfg.dailyLimit ||
      Number(draft.weeklyLimit) !== cfg.weeklyLimit ||
      Number(draft.cooldownMinutes) !== cfg.cooldownMinutes,
    [draft, cfg],
  )

  function showFlash(type, message) {
    setFlash({ type, message })
    window.setTimeout(() => setFlash(null), 4000)
  }

  const appendLog = useCallback((message) => {
    const entry = {
      id: newId(),
      at: new Date().toISOString(),
      message,
    }
    return (c) => ({ ...c, logs: [entry, ...(c.logs || [])].slice(0, 200) })
  }, [])

  const trackRuntimeDevice = useCallback(
    async (deviceId, fingerprint = '') => {
      const nextDeviceId = String(deviceId ?? '').trim()
      const nextFingerprint = String(fingerprint ?? '').trim()
      if (!nextDeviceId) {
        showToast('error', 'Enter a device ID to track runtime state.')
        return
      }
      setRuntimeDeviceId(nextDeviceId)
      setRuntimeFingerprint(nextFingerprint)
      trackSubscriptionDevice({
        deviceId: nextDeviceId,
        fingerprint: nextFingerprint,
      })
      try {
        await refreshSubscriptionState({
          deviceId: nextDeviceId,
          fingerprint: nextFingerprint,
        })
      } catch (e) {
        showToast('error', e?.message || 'Could not refresh tracked runtime state')
      }
    },
    [refreshSubscriptionState, showToast, trackSubscriptionDevice],
  )

  async function handleSaveSettings(e) {
    e.preventDefault()
    const daily = Math.max(1, Math.floor(Number(draft.dailyLimit)))
    const weekly = Math.max(daily, Math.floor(Number(draft.weeklyLimit)))
    const cool = Math.max(5, Math.floor(Number(draft.cooldownMinutes)))
    const requestPayload = {
      transferMode: draft.transferMode,
      dailyLimit: daily,
      weeklyLimit: weekly,
      cooldownMinutes: cool,
    }
    try {
      const saved = await putDeviceControlSettings(requestPayload)
      const hydrated = normalizeDeviceControlFromServer(saved)
      setCfg(hydrated)
      setDraft({
        transferMode: hydrated.transferMode,
        dailyLimit: hydrated.dailyLimit,
        weeklyLimit: hydrated.weeklyLimit,
        cooldownMinutes: hydrated.cooldownMinutes,
      })
      showFlash('success', 'Settings saved.')
    } catch (err) {
      showToast('error', err?.message || 'Save failed')
    }
  }

  const handleForceTransferSubmit = useCallback(
    async (e) => {
      e.preventDefault()
      const phone = forcePaymentPhone.trim()
      const deviceId = forceTargetDeviceId.trim()
      if (!phone || !deviceId) {
        showToast('error', 'Enter payment phone and new device ID.')
        return
      }
      setRuntimeBusy('force-phone')
      try {
        await postAdminForceTransferPhone({
          payment_phone: phone,
          target_device_id: deviceId,
        })
        await trackRuntimeDevice(deviceId)
        setCfg((c) =>
          appendLog(
            `Force transfer completed · ${phone.replace(/\s+/g, '')} → ${deviceId.slice(0, 32)}${deviceId.length > 32 ? '…' : ''}`,
          )(c),
        )
        setForcePaymentPhone('')
        setForceTargetDeviceId('')
        await loadCfg()
        showFlash('success', 'Force transfer completed.')
      } catch (err) {
        showToast('error', err?.message || 'Force transfer failed')
      } finally {
        setRuntimeBusy('')
      }
    },
    [appendLog, forcePaymentPhone, forceTargetDeviceId, loadCfg, showToast, trackRuntimeDevice],
  )

  const handleForceTransferByIdSubmit = useCallback(
    async (e) => {
      e.preventDefault()
      const source = forceSourceDeviceId.trim()
      const target = forceTargetDeviceId.trim()
      if (!source || !target) {
        showToast('error', 'Enter source device ID and target device ID.')
        return
      }
      setRuntimeBusy('force-id')
      try {
        await postAdminForceTransfer({
          source_device_id: source,
          target_device_id: target,
        })
        await trackRuntimeDevice(target)
        setForceTargetDeviceId('')
        setForceSourceDeviceId('')
        await loadCfg()
        showFlash('success', 'Admin device-to-device force transfer completed.')
      } catch (err) {
        showToast('error', err?.message || 'Device force transfer failed')
      } finally {
        setRuntimeBusy('')
      }
    },
    [forceSourceDeviceId, forceTargetDeviceId, loadCfg, showToast, trackRuntimeDevice],
  )

  const handleTransferRequestSubmit = useCallback(
    async (e) => {
      e.preventDefault()
      const source = requestSourceDeviceId.trim()
      const phone = requestPaymentPhone.trim()
      if (!source || !phone) {
        showToast('error', 'Enter source device ID and payment phone.')
        return
      }
      setRuntimeBusy('request')
      try {
        const out = await postTransferRequest({
          source_device_id: source,
          payment_phone: phone,
          ...(requestTargetFingerprint.trim() ? { target_fingerprint: requestTargetFingerprint.trim() } : {}),
        })
        setIssuedTransfer(out)
        setConfirmCode(String(out?.code ?? ''))
        await loadCfg()
        showFlash('success', 'Canonical transfer code issued.')
      } catch (err) {
        showToast('error', err?.message || 'Transfer request failed')
      } finally {
        setRuntimeBusy('')
      }
    },
    [loadCfg, requestPaymentPhone, requestSourceDeviceId, requestTargetFingerprint, showToast],
  )

  const handleTransferConfirmSubmit = useCallback(
    async (e) => {
      e.preventDefault()
      const code = confirmCode.trim()
      const target = confirmTargetDeviceId.trim()
      const fingerprint = confirmTargetFingerprint.trim()
      if (!code || !target) {
        showToast('error', 'Enter transfer code and target device ID.')
        return
      }
      setRuntimeBusy('confirm')
      try {
        const out = await postTransferConfirm({
          code,
          target_device_id: target,
          ...(fingerprint ? { target_fingerprint: fingerprint } : {}),
        })
        await trackRuntimeDevice(target, fingerprint)
        await loadCfg()
        showFlash(
          'success',
          `Transfer confirmed. Source ${String(out?.source_device_id || '').slice(0, 18)} -> target ${target.slice(0, 18)}`,
        )
      } catch (err) {
        showToast('error', err?.message || 'Transfer confirm failed')
      } finally {
        setRuntimeBusy('')
      }
    },
    [confirmCode, confirmTargetDeviceId, confirmTargetFingerprint, loadCfg, showToast, trackRuntimeDevice],
  )

  const handleRevokeSubmit = useCallback(
    async (e) => {
      e.preventDefault()
      const deviceId = revokeDeviceId.trim()
      if (!deviceId) {
        showToast('error', 'Enter a device ID to revoke.')
        return
      }
      setRuntimeBusy('revoke')
      try {
        await postSubscriptionRevoke({ device_id: deviceId })
        await trackRuntimeDevice(deviceId)
        await loadCfg()
        showFlash('success', 'Subscription revoked. Runtime invalidation should propagate immediately.')
      } catch (err) {
        showToast('error', err?.message || 'Revoke failed')
      } finally {
        setRuntimeBusy('')
      }
    },
    [loadCfg, revokeDeviceId, showToast, trackRuntimeDevice],
  )

  const handleRecoverSubmit = useCallback(
    async (e) => {
      e.preventDefault()
      const deviceId = recoverDeviceId.trim()
      const fingerprint = recoverFingerprint.trim()
      if (!deviceId || !fingerprint) {
        showToast('error', 'Enter device ID and fingerprint to recover.')
        return
      }
      setRuntimeBusy('recover')
      try {
        await postSubscriptionRecover({
          device_id: deviceId,
          fingerprint,
        })
        await trackRuntimeDevice(deviceId, fingerprint)
        await loadCfg()
        showFlash('success', 'Recovery applied. Runtime refresh is now tracking the recovered device.')
      } catch (err) {
        showToast('error', err?.message || 'Recover failed')
      } finally {
        setRuntimeBusy('')
      }
    },
    [loadCfg, recoverDeviceId, recoverFingerprint, showToast, trackRuntimeDevice],
  )

  const trackedRuntimeId = trackedDeviceId || runtimeDeviceId
  const runtimeGateLabel =
    subscriptionState.playbackGateReason ||
    (subscriptionState.playbackAllowed ? 'playback_allowed' : 'awaiting_runtime_refresh')

  return (
    <>
      <SecurityPinModal
        open={pendingBulkPin != null}
        title="Ingiza Security PIN"
        errorText={pendingPinErr}
        busy={pendingPinBusy}
        onClose={() => !pendingPinBusy && setPendingBulkPin(null)}
        onSubmit={submitPendingBulkPin}
      />
      <Topbar />
      <main className="mt-6 flex min-h-0 flex-1 flex-col gap-6">
        {flash ? (
          <FlashMessage type={flash.type} message={flash.message} onDismiss={() => setFlash(null)} />
        ) : null}

        <header>
          <h1 className="text-2xl font-bold text-white sm:text-3xl">Device Control</h1>
          <p className="mt-1 text-sm text-slate-400">
            Transfer limits, pending queue, audit trail, and admin force transfer
          </p>
        </header>

        <div className="flex flex-wrap gap-2 border-b border-slate-800 pb-2">
          {TABS.map((t) => {
            const Icon = t.icon
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors ${
                  tab === t.id
                    ? 'bg-gradient-to-r from-amber-400 to-yellow-500 text-slate-950'
                    : 'bg-slate-800/70 text-slate-400 hover:bg-slate-800'
                }`}
              >
                <Icon className="h-4 w-4" />
                {t.label}
              </button>
            )
          })}
        </div>

        {tab === 'settings' ? (
          <form
            onSubmit={handleSaveSettings}
            className="max-w-xl space-y-5 rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6 ring-1 ring-white/[0.04]"
          >
            <div className="flex items-center justify-between rounded-xl border border-slate-600/50 bg-slate-900/40 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-slate-200">Transfer mode</p>
                <p className="text-xs text-slate-500">
                  Retained for compatibility with clients; transfer access is gated by persisted limits below.
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setDraft((d) => ({ ...d, transferMode: 'confirmation' }))}
                  className={`rounded-lg px-3 py-1.5 text-xs font-bold uppercase ${
                    draft.transferMode === 'confirmation'
                      ? 'bg-amber-500/25 text-amber-100 ring-1 ring-amber-400/40'
                      : 'text-slate-500'
                  }`}
                >
                  Confirmation
                </button>
                <button
                  type="button"
                  onClick={() => setDraft((d) => ({ ...d, transferMode: 'manual' }))}
                  className={`rounded-lg px-3 py-1.5 text-xs font-bold uppercase ${
                    draft.transferMode === 'manual'
                      ? 'bg-amber-500/25 text-amber-100 ring-1 ring-amber-400/40'
                      : 'text-slate-500'
                  }`}
                >
                  Manual
                </button>
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase text-slate-400">
                Daily limit
              </label>
              <input
                type="number"
                min={1}
                value={draft.dailyLimit}
                onChange={(e) => setDraft((d) => ({ ...d, dailyLimit: e.target.value }))}
                className={inputClass()}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase text-slate-400">
                Weekly limit
              </label>
              <input
                type="number"
                min={1}
                value={draft.weeklyLimit}
                onChange={(e) => setDraft((d) => ({ ...d, weeklyLimit: e.target.value }))}
                className={inputClass()}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase text-slate-400">
                Cooldown (minutes)
              </label>
              <input
                type="number"
                min={5}
                step={5}
                value={draft.cooldownMinutes}
                onChange={(e) => setDraft((d) => ({ ...d, cooldownMinutes: e.target.value }))}
                className={inputClass()}
              />
            </div>

            <button
              type="submit"
              disabled={!dirty}
              className="rounded-xl bg-gradient-to-r from-amber-400 to-yellow-500 px-8 py-3 text-sm font-bold text-slate-950 disabled:opacity-40"
            >
              Save settings
            </button>
          </form>
        ) : null}

        {tab === 'pending' ? (
          <section className="space-y-4">
            {pendingSel.size > 0 ? (
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/5 px-3 py-2">
                <span className="text-xs font-semibold text-amber-100">
                  Umechagua {pendingSel.size} (vifaa vya chanzo)
                </span>
                <button
                  type="button"
                  disabled={pendingPinBusy}
                  onClick={() => {
                    const deviceIds = [
                      ...new Set(
                        (cfg.pending || [])
                          .filter((p) => pendingSel.has(p.id))
                          .map((p) => p.sourceDeviceId)
                          .filter(Boolean),
                      ),
                    ]
                    if (deviceIds.length === 0) {
                      showToast('error', 'Hakuna device ID ya chanzo kwenye mistari uliyochagua')
                      return
                    }
                    setPendingPinErr('')
                    setPendingBulkPin(() => async (securityPin) => {
                      await postManualSubscriptionBulkBlock({ deviceIds, securityPin })
                    })
                  }}
                  className="rounded-md bg-rose-600/90 px-2.5 py-1.5 text-[11px] font-bold text-white hover:bg-rose-500 disabled:opacity-40"
                >
                  BLOCK ULIOCHAGUA
                </button>
                <button
                  type="button"
                  disabled={pendingPinBusy}
                  onClick={() => {
                    const deviceIds = [
                      ...new Set(
                        (cfg.pending || [])
                          .filter((p) => pendingSel.has(p.id))
                          .map((p) => p.sourceDeviceId)
                          .filter(Boolean),
                      ),
                    ]
                    if (deviceIds.length === 0) {
                      showToast('error', 'Hakuna device ID ya chanzo kwenye mistari uliyochagua')
                      return
                    }
                    setPendingPinErr('')
                    setPendingBulkPin(() => async (securityPin) => {
                      await postManualSubscriptionBulkUnblock({ deviceIds, securityPin })
                    })
                  }}
                  className="rounded-md bg-emerald-700/90 px-2.5 py-1.5 text-[11px] font-bold text-white hover:bg-emerald-600 disabled:opacity-40"
                >
                  UNBLOCK ULIOCHAGUA
                </button>
              </div>
            ) : null}
            <div className="overflow-hidden rounded-2xl border border-slate-700/60 bg-slate-950/40 ring-1 ring-white/[0.04]">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-700 bg-slate-900/60 text-[11px] uppercase text-slate-400">
                  <tr>
                    <th className="w-10 px-2 py-3">
                      <input
                        type="checkbox"
                        title="Chagua zote"
                        aria-label="Chagua zote"
                        className="h-4 w-4 rounded border-slate-500 bg-slate-900 text-amber-500"
                        checked={allPendingChecked}
                        onChange={() =>
                          setPendingSel((prev) => {
                            const list = cfg.pending || []
                            if (list.length > 0 && list.every((p) => prev.has(p.id))) return new Set()
                            return new Set(list.map((p) => p.id))
                          })
                        }
                      />
                    </th>
                    <th className="px-4 py-3">Device</th>
                    <th className="px-4 py-3">Requested</th>
                    <th className="px-4 py-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(cfg.pending || []).length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-4 py-10 text-center text-slate-500">
                        No recent transfer activity.
                      </td>
                    </tr>
                  ) : (
                    cfg.pending.map((p) => (
                      <tr key={p.id} className="border-b border-slate-800/80">
                        <td className="px-2 py-3 align-middle">
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-slate-500 bg-slate-900 text-amber-500"
                            checked={pendingSel.has(p.id)}
                            onChange={() =>
                              setPendingSel((prev) => {
                                const n = new Set(prev)
                                if (n.has(p.id)) n.delete(p.id)
                                else n.add(p.id)
                                return n
                              })
                            }
                            aria-label={`Chagua ${p.deviceLabel}`}
                          />
                        </td>
                        <td className="px-4 py-3 text-slate-200">{p.deviceLabel}</td>
                        <td className="px-4 py-3 text-slate-400">
                          {formatReadableDateTime(p.requestedAt)}
                        </td>
                        <td className="px-4 py-3">
                          <span className="rounded-lg bg-amber-500/20 px-2 py-0.5 text-xs font-bold uppercase text-amber-100 ring-1 ring-amber-400/35">
                            {p.status}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {tab === 'logs' ? (
          <section className="rounded-2xl border border-slate-700/60 bg-slate-950/40 ring-1 ring-white/[0.04]">
            <div className="max-h-[480px] overflow-y-auto">
              {(cfg.logs || []).length === 0 ? (
                <p className="py-12 text-center text-slate-500">No log entries yet.</p>
              ) : (
                <ul className="divide-y divide-slate-800/90">
                  {cfg.logs.map((l) => (
                    <li key={l.id} className="px-4 py-3 text-sm">
                      <span className="font-mono text-xs text-slate-500">
                        {formatReadableDateTime(l.at)}
                      </span>
                      <p className="mt-1 text-slate-300">{l.message}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        ) : null}

        {tab === 'force' ? (
          <section className="grid gap-6 xl:grid-cols-2">
            <div className="space-y-5 rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6 ring-1 ring-white/[0.04] xl:col-span-2">
              <div>
                <h2 className="text-lg font-semibold text-white">Tracked Runtime Device</h2>
                <p className="mt-2 text-sm text-slate-400">
                  Shared runtime watcher uses canonical verify/status plus subscription SSE so revoke, transfer,
                  and recover changes invalidate the website immediately.
                </p>
              </div>
              <div className="grid gap-4 lg:grid-cols-[1fr_1fr_auto_auto]">
                <input
                  type="text"
                  placeholder="Device ID to track"
                  value={runtimeDeviceId}
                  onChange={(e) => setRuntimeDeviceId(e.target.value)}
                  className={inputClass()}
                />
                <input
                  type="text"
                  placeholder="Fingerprint (optional)"
                  value={runtimeFingerprint}
                  onChange={(e) => setRuntimeFingerprint(e.target.value)}
                  className={inputClass()}
                />
                <button
                  type="button"
                  onClick={() => {
                    void trackRuntimeDevice(runtimeDeviceId, runtimeFingerprint)
                  }}
                  className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm font-semibold text-amber-100 hover:bg-amber-500/20"
                >
                  Track Runtime
                </button>
                <button
                  type="button"
                  onClick={() => {
                    clearSubscription()
                    setRuntimeDeviceId('')
                    setRuntimeFingerprint('')
                  }}
                  className="rounded-xl border border-slate-600 px-4 py-3 text-sm font-semibold text-slate-200 hover:bg-slate-800"
                >
                  Clear
                </button>
              </div>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-xl border border-slate-700 bg-slate-900/50 px-4 py-3">
                  <p className="text-[11px] uppercase tracking-wide text-slate-500">Tracked device</p>
                  <p className="mt-1 text-sm text-white">{trackedRuntimeId || '—'}</p>
                </div>
                <div className="rounded-xl border border-slate-700 bg-slate-900/50 px-4 py-3">
                  <p className="text-[11px] uppercase tracking-wide text-slate-500">Subscription status</p>
                  <p className="mt-1 text-sm text-white">{subscriptionState.status || 'unknown'}</p>
                </div>
                <div className="rounded-xl border border-slate-700 bg-slate-900/50 px-4 py-3">
                  <p className="text-[11px] uppercase tracking-wide text-slate-500">Playback gate</p>
                  <p className="mt-1 text-sm text-white">{runtimeGateLabel}</p>
                </div>
                <div className="rounded-xl border border-slate-700 bg-slate-900/50 px-4 py-3">
                  <p className="text-[11px] uppercase tracking-wide text-slate-500">Expires</p>
                  <p className="mt-1 text-sm text-white">{subscriptionState.expiresAt || '—'}</p>
                </div>
              </div>
            </div>

            <form
              onSubmit={handleTransferRequestSubmit}
              className="space-y-4 rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6 ring-1 ring-white/[0.04]"
            >
              <div>
                <h2 className="text-lg font-semibold text-white">Canonical Transfer Request</h2>
                <p className="mt-2 text-sm text-slate-400">
                  Calls <code>/api/transfer/request</code> with the mobile-compatible DTO.
                </p>
              </div>
              <input
                type="text"
                placeholder="Source device ID"
                value={requestSourceDeviceId}
                onChange={(e) => setRequestSourceDeviceId(e.target.value)}
                className={inputClass()}
              />
              <input
                type="tel"
                placeholder="Payment phone"
                value={requestPaymentPhone}
                onChange={(e) => setRequestPaymentPhone(e.target.value)}
                className={inputClass()}
              />
              <input
                type="text"
                placeholder="Target fingerprint (optional)"
                value={requestTargetFingerprint}
                onChange={(e) => setRequestTargetFingerprint(e.target.value)}
                className={inputClass()}
              />
              {issuedTransfer ? (
                <div className="rounded-xl border border-slate-700 bg-slate-900/50 px-4 py-3 text-xs text-slate-300">
                  <p>code: {issuedTransfer.code}</p>
                  <p>expires_at: {issuedTransfer.expires_at || '—'}</p>
                  <p>source_device_id: {issuedTransfer.source_device_id || '—'}</p>
                </div>
              ) : null}
              <button
                type="submit"
                disabled={runtimeBusy !== ''}
                className="rounded-xl bg-gradient-to-r from-amber-400 to-yellow-500 px-6 py-3 text-sm font-bold text-slate-950 disabled:opacity-50"
              >
                {runtimeBusy === 'request' ? 'Issuing…' : 'Issue Transfer Code'}
              </button>
            </form>

            <form
              onSubmit={handleTransferConfirmSubmit}
              className="space-y-4 rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6 ring-1 ring-white/[0.04]"
            >
              <div>
                <h2 className="text-lg font-semibold text-white">Canonical Transfer Confirm</h2>
                <p className="mt-2 text-sm text-slate-400">
                  Confirms ownership move through <code>/api/transfer/confirm</code> and switches runtime
                  tracking to the target device.
                </p>
              </div>
              <input
                type="text"
                placeholder="Transfer code"
                value={confirmCode}
                onChange={(e) => setConfirmCode(e.target.value.toUpperCase())}
                className={inputClass()}
              />
              <input
                type="text"
                placeholder="Target device ID"
                value={confirmTargetDeviceId}
                onChange={(e) => setConfirmTargetDeviceId(e.target.value)}
                className={inputClass()}
              />
              <input
                type="text"
                placeholder="Target fingerprint (optional)"
                value={confirmTargetFingerprint}
                onChange={(e) => setConfirmTargetFingerprint(e.target.value)}
                className={inputClass()}
              />
              <button
                type="submit"
                disabled={runtimeBusy !== ''}
                className="rounded-xl bg-gradient-to-r from-emerald-400 to-teal-500 px-6 py-3 text-sm font-bold text-slate-950 disabled:opacity-50"
              >
                {runtimeBusy === 'confirm' ? 'Confirming…' : 'Confirm Transfer'}
              </button>
            </form>

            <form
              onSubmit={handleForceTransferSubmit}
              className="space-y-4 rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6 ring-1 ring-white/[0.04]"
            >
              <div>
                <h2 className="text-lg font-semibold text-white">Admin Force Transfer by Phone</h2>
                <p className="mt-2 text-sm text-slate-400">
                  Uses <code>/api/transfer/admin-force-phone</code> to move the subscription without client
                  confirmation.
                </p>
              </div>
              <input
                type="tel"
                autoComplete="tel"
                placeholder="Payment phone"
                value={forcePaymentPhone}
                onChange={(e) => setForcePaymentPhone(e.target.value)}
                className={inputClass()}
              />
              <input
                type="text"
                placeholder="Target device ID"
                value={forceTargetDeviceId}
                onChange={(e) => setForceTargetDeviceId(e.target.value)}
                className={inputClass()}
              />
              <button
                type="submit"
                disabled={runtimeBusy !== ''}
                className="rounded-xl bg-gradient-to-r from-amber-400 to-yellow-500 px-6 py-3 text-sm font-bold text-slate-950 disabled:opacity-50"
              >
                {runtimeBusy === 'force-phone' ? 'Transferring…' : 'Force Transfer by Phone'}
              </button>
            </form>

            <form
              onSubmit={handleForceTransferByIdSubmit}
              className="space-y-4 rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6 ring-1 ring-white/[0.04]"
            >
              <div>
                <h2 className="text-lg font-semibold text-white">Admin Force Transfer by Device IDs</h2>
                <p className="mt-2 text-sm text-slate-400">
                  Uses <code>/api/transfer/admin-force</code> for explicit source/target migration.
                </p>
              </div>
              <input
                type="text"
                placeholder="Source device ID"
                value={forceSourceDeviceId}
                onChange={(e) => setForceSourceDeviceId(e.target.value)}
                className={inputClass()}
              />
              <input
                type="text"
                placeholder="Target device ID"
                value={forceTargetDeviceId}
                onChange={(e) => setForceTargetDeviceId(e.target.value)}
                className={inputClass()}
              />
              <button
                type="submit"
                disabled={runtimeBusy !== ''}
                className="rounded-xl bg-gradient-to-r from-orange-400 to-amber-500 px-6 py-3 text-sm font-bold text-slate-950 disabled:opacity-50"
              >
                {runtimeBusy === 'force-id' ? 'Moving…' : 'Force Transfer by IDs'}
              </button>
            </form>

            <form
              onSubmit={handleRevokeSubmit}
              className="space-y-4 rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6 ring-1 ring-white/[0.04]"
            >
              <div>
                <h2 className="text-lg font-semibold text-white">Revoke Runtime</h2>
                <p className="mt-2 text-sm text-slate-400">
                  Calls <code>/api/subscription/revoke</code> and keeps the website pinned to the revoked
                  device so runtime invalidation is visible.
                </p>
              </div>
              <input
                type="text"
                placeholder="Device ID to revoke"
                value={revokeDeviceId}
                onChange={(e) => setRevokeDeviceId(e.target.value)}
                className={inputClass()}
              />
              <button
                type="submit"
                disabled={runtimeBusy !== ''}
                className="rounded-xl bg-gradient-to-r from-rose-500 to-red-600 px-6 py-3 text-sm font-bold text-white disabled:opacity-50"
              >
                {runtimeBusy === 'revoke' ? 'Revoking…' : 'Revoke Subscription'}
              </button>
            </form>

            <form
              onSubmit={handleRecoverSubmit}
              className="space-y-4 rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6 ring-1 ring-white/[0.04]"
            >
              <div>
                <h2 className="text-lg font-semibold text-white">Recover Runtime</h2>
                <p className="mt-2 text-sm text-slate-400">
                  Calls <code>/api/subscription/recover</code> using the canonical device/fingerprint DTO.
                </p>
              </div>
              <input
                type="text"
                placeholder="Recovered device ID"
                value={recoverDeviceId}
                onChange={(e) => setRecoverDeviceId(e.target.value)}
                className={inputClass()}
              />
              <input
                type="text"
                placeholder="Fingerprint"
                value={recoverFingerprint}
                onChange={(e) => setRecoverFingerprint(e.target.value)}
                className={inputClass()}
              />
              <button
                type="submit"
                disabled={runtimeBusy !== ''}
                className="rounded-xl bg-gradient-to-r from-sky-400 to-cyan-500 px-6 py-3 text-sm font-bold text-slate-950 disabled:opacity-50"
              >
                {runtimeBusy === 'recover' ? 'Recovering…' : 'Recover Subscription'}
              </button>
            </form>
          </section>
        ) : null}
      </main>
    </>
  )
}

export default DeviceControlPage
