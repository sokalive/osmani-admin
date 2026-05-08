import { useCallback, useEffect, useMemo, useState } from 'react'
import { ClipboardList, Hourglass, Settings, Zap } from 'lucide-react'
import FlashMessage from '../components/FlashMessage'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import { getDeviceControlSettings, postAdminForceTransferPhone, putDeviceControlSettings } from '../lib/api'
import { appendSecurityLog } from '../lib/securityActivityLog'
import { formatReadableDateTime } from '../lib/formatTxDisplay'

function newId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `dc-${Date.now()}`
}

function defaultDevice() {
  return {
    transferMode: 'confirmation',
    transferEnabled: true,
    dailyLimit: 5,
    weeklyLimit: 15,
    cooldownMinutes: 60,
    pending: [],
    logs: [],
  }
}

function normalizeDeviceControlFromServer(s) {
  if (!s || typeof s !== 'object') throw new Error('Invalid settings response')
  return {
    transferMode: String(s.transferMode || 'confirmation') === 'manual' ? 'manual' : 'confirmation',
    transferEnabled: Boolean(s.transferEnabled),
    dailyLimit: Number(s.dailyLimit),
    weeklyLimit: Number(s.weeklyLimit),
    cooldownMinutes: Number(s.cooldownMinutes),
    pending: Array.isArray(s.pending) ? s.pending : [],
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
  const [cfg, setCfg] = useState(() => defaultDevice())
  const [draft, setDraft] = useState(() => ({
    transferMode: defaultDevice().transferMode,
    transferEnabled: defaultDevice().transferEnabled,
    dailyLimit: defaultDevice().dailyLimit,
    weeklyLimit: defaultDevice().weeklyLimit,
    cooldownMinutes: defaultDevice().cooldownMinutes,
  }))
  const [tab, setTab] = useState('settings')
  const [flash, setFlash] = useState(null)
  const [forcePaymentPhone, setForcePaymentPhone] = useState('')
  const [forceNewDeviceId, setForceNewDeviceId] = useState('')
  const [forceSubmitting, setForceSubmitting] = useState(false)

  const loadCfg = useCallback(async () => {
    try {
      const s = await getDeviceControlSettings()
      console.log('[device-control-ui] fetched settings', s)
      const hydrated = normalizeDeviceControlFromServer(s)
      setCfg(hydrated)
      setDraft({
        transferMode: hydrated.transferMode,
        transferEnabled: hydrated.transferEnabled,
        dailyLimit: hydrated.dailyLimit,
        weeklyLimit: hydrated.weeklyLimit,
        cooldownMinutes: hydrated.cooldownMinutes,
      })
      console.log('[device-control-ui] state after refresh', {
        transferEnabled: hydrated.transferEnabled,
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

  const dirty = useMemo(
    () =>
      draft.transferMode !== cfg.transferMode ||
      Boolean(draft.transferEnabled) !== Boolean(cfg.transferEnabled) ||
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

  async function handleSaveSettings(e) {
    e.preventDefault()
    console.log('[device-control-ui] toggle before save', {
      transferEnabled: draft.transferEnabled,
      transferMode: draft.transferMode,
    })
    const daily = Math.max(1, Math.floor(Number(draft.dailyLimit)))
    const weekly = Math.max(daily, Math.floor(Number(draft.weeklyLimit)))
    const cool = Math.max(5, Math.floor(Number(draft.cooldownMinutes)))
    const next = appendLog('Device control settings saved.')({
      ...cfg,
      transferMode: draft.transferMode,
      transferEnabled: Boolean(draft.transferEnabled),
      dailyLimit: daily,
      weeklyLimit: weekly,
      cooldownMinutes: cool,
    })
    const requestPayload = {
      transferMode: draft.transferMode,
      transferEnabled: Boolean(draft.transferEnabled),
      dailyLimit: daily,
      weeklyLimit: weekly,
      cooldownMinutes: cool,
      pending: Array.isArray(cfg.pending) ? cfg.pending : [],
      logs: Array.isArray(next.logs) ? next.logs : [],
    }
    try {
      console.log('[device-control-ui] payload sent', requestPayload)
      const saved = await putDeviceControlSettings(requestPayload)
      console.log('[device-control-ui] saved settings response', saved)
      const hydrated = normalizeDeviceControlFromServer(saved)
      setCfg(hydrated)
      setDraft({
        transferMode: hydrated.transferMode,
        transferEnabled: hydrated.transferEnabled,
        dailyLimit: hydrated.dailyLimit,
        weeklyLimit: hydrated.weeklyLimit,
        cooldownMinutes: hydrated.cooldownMinutes,
      })
      console.log('[device-control-ui] state after save', {
        transferEnabled: hydrated.transferEnabled,
        dailyLimit: hydrated.dailyLimit,
        weeklyLimit: hydrated.weeklyLimit,
        cooldownMinutes: hydrated.cooldownMinutes,
      })
      await appendSecurityLog({
        actor: 'policy-engine',
        eventType: 'Policy enforcement',
        status: 'completed',
        detail: `enabled:${draft.transferEnabled ? 'yes' : 'no'} · mode:${draft.transferMode} · daily ${daily} · weekly ${weekly} · cool ${cool}m`,
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
      const deviceId = forceNewDeviceId.trim()
      if (!phone || !deviceId) {
        showToast('error', 'Enter payment phone and new device ID.')
        return
      }
      setForceSubmitting(true)
      try {
        await postAdminForceTransferPhone({
          payment_phone: phone,
          target_device_id: deviceId,
        })
        setCfg((c) =>
          appendLog(
            `Force transfer completed · ${phone.replace(/\s+/g, '')} → ${deviceId.slice(0, 32)}${deviceId.length > 32 ? '…' : ''}`,
          )(c),
        )
        await appendSecurityLog({
          actor: 'Admin',
          eventType: 'Force transfer',
          status: 'completed',
          detail: `Admin force transfer by payment phone → ${deviceId.slice(0, 48)}`,
        })
        setForcePaymentPhone('')
        setForceNewDeviceId('')
        showFlash('success', 'Force transfer completed.')
      } catch (err) {
        showToast('error', err?.message || 'Force transfer failed')
      } finally {
        setForceSubmitting(false)
      }
    },
    [appendLog, forceNewDeviceId, forcePaymentPhone, showToast],
  )

  return (
    <>
      <Topbar />
      <main className="mt-6 flex min-h-0 flex-1 flex-col gap-6">
        {flash ? (
          <FlashMessage type={flash.type} message={flash.message} onDismiss={() => setFlash(null)} />
        ) : null}

        <header>
          <h1 className="text-2xl font-bold text-white sm:text-3xl">Device Control</h1>
          <p className="mt-1 text-sm text-slate-400">
            Transfer limits, pending queue, audit trail, and emergency actions
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
                <p className="text-sm font-medium text-slate-200">Ruhusu Uhamishaji wa Kifurushi</p>
                <p className="text-xs text-slate-500">
                  Ukizima, `/api/transfer/request` itareturn maintenance response kwa app users.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDraft((d) => ({ ...d, transferEnabled: !d.transferEnabled }))}
                className={`inline-flex h-8 w-16 items-center rounded-full border px-1 transition ${
                  draft.transferEnabled
                    ? 'border-emerald-400/45 bg-emerald-500/20'
                    : 'border-slate-600 bg-slate-800'
                }`}
                aria-label="Ruhusu Uhamishaji wa Kifurushi"
              >
                <span
                  className={`h-6 w-6 rounded-full transition ${
                    draft.transferEnabled
                      ? 'translate-x-8 bg-emerald-300'
                      : 'translate-x-0 bg-slate-400'
                  }`}
                />
              </button>
            </div>

            <div className="flex items-center justify-between rounded-xl border border-slate-600/50 bg-slate-900/40 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-slate-200">Transfer mode</p>
                <p className="text-xs text-slate-500">
                  Legacy setting retained for compatibility. Live flow is immediate transfer by code.
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
            <div className="overflow-hidden rounded-2xl border border-slate-700/60 bg-slate-950/40 ring-1 ring-white/[0.04]">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-700 bg-slate-900/60 text-[11px] uppercase text-slate-400">
                  <tr>
                    <th className="px-4 py-3">Device</th>
                    <th className="px-4 py-3">Requested</th>
                    <th className="px-4 py-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(cfg.pending || []).length === 0 ? (
                    <tr>
                      <td colSpan={3} className="px-4 py-10 text-center text-slate-500">
                        No recent transfer activity.
                      </td>
                    </tr>
                  ) : (
                    cfg.pending.map((p) => (
                      <tr key={p.id} className="border-b border-slate-800/80">
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
          <form
            onSubmit={handleForceTransferSubmit}
            className="max-w-xl space-y-5 rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6 ring-1 ring-white/[0.04]"
          >
            <div>
              <h2 className="text-lg font-semibold text-white">Force Transfer Device</h2>
              <p className="mt-2 text-sm text-slate-400">
                Transfer a subscription to a new device without requiring old device confirmation.
              </p>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">
                Namba ya zamani (iliyolipia kifurushi)
              </label>
              <input
                type="tel"
                autoComplete="tel"
                placeholder="e.g. +255712345678"
                value={forcePaymentPhone}
                onChange={(e) => setForcePaymentPhone(e.target.value)}
                className={inputClass()}
              />
              <p className="mt-1.5 text-xs text-slate-500">Weka namba iliyotumika kulipia kifurushi</p>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">
                Device ID ya simu mpya
              </label>
              <input
                type="text"
                placeholder="Paste new device ID"
                value={forceNewDeviceId}
                onChange={(e) => setForceNewDeviceId(e.target.value)}
                className={inputClass()}
              />
              <p className="mt-1.5 text-xs text-slate-500">Pata Device ID kutoka kwenye simu mpya ya user</p>
            </div>

            <button
              type="submit"
              disabled={forceSubmitting}
              className="rounded-xl bg-gradient-to-r from-amber-400 to-yellow-500 px-8 py-3 text-sm font-bold text-slate-950 disabled:opacity-50"
            >
              {forceSubmitting ? 'Transferring…' : 'Force Transfer Device'}
            </button>
          </form>
        ) : null}
      </main>
    </>
  )
}

export default DeviceControlPage
