import { useCallback, useEffect, useMemo, useState } from 'react'
import { ClipboardList, Hourglass, Settings, Zap } from 'lucide-react'
import FlashMessage from '../components/FlashMessage'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import { getDeviceControlSettings, postAdminForceTransferPhone, putDeviceControlSettings } from '../lib/api'
import { appendSecurityLog } from '../lib/securityActivityLog'

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

function inputClass() {
  return 'w-full rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-100 focus:border-amber-500/60 focus:outline-none focus:ring-2 focus:ring-amber-500/25'
}

const TABS = [
  { id: 'settings', label: 'Settings', icon: Settings },
  { id: 'pending', label: 'Pending', icon: Hourglass },
  { id: 'logs', label: 'Logs', icon: ClipboardList },
  { id: 'force', label: 'Force Transfer', icon: Zap },
]

function DeviceControlPage() {
  const { showToast } = useToast()
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
  const [forceNewDeviceId, setForceNewDeviceId] = useState('')
  const [forceSubmitting, setForceSubmitting] = useState(false)

  const loadCfg = useCallback(async () => {
    try {
      const s = await getDeviceControlSettings()
      const merged = { ...defaultDevice(), ...s }
      setCfg(merged)
      setDraft({
        transferMode: merged.transferMode,
        dailyLimit: merged.dailyLimit,
        weeklyLimit: merged.weeklyLimit,
        cooldownMinutes: merged.cooldownMinutes,
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
    const daily = Math.max(1, Math.floor(Number(draft.dailyLimit)))
    const weekly = Math.max(daily, Math.floor(Number(draft.weeklyLimit)))
    const cool = Math.max(5, Math.floor(Number(draft.cooldownMinutes)))
    const next = appendLog('Device control settings saved.')({
      ...cfg,
      transferMode: draft.transferMode,
      dailyLimit: daily,
      weeklyLimit: weekly,
      cooldownMinutes: cool,
    })
    try {
      const saved = await putDeviceControlSettings(next)
      setCfg(saved)
      setDraft({
        transferMode: saved.transferMode,
        dailyLimit: saved.dailyLimit,
        weeklyLimit: saved.weeklyLimit,
        cooldownMinutes: saved.cooldownMinutes,
      })
      await appendSecurityLog({
        actor: 'policy-engine',
        eventType: 'Policy enforcement',
        status: 'completed',
        detail: `mode:${draft.transferMode} · daily ${daily} · weekly ${weekly} · cool ${cool}m`,
      })
      showFlash('success', 'Settings saved.')
    } catch (err) {
      showToast('error', err?.message || 'Save failed')
    }
  }

  const simulatePending = useCallback(async () => {
    const devices = ['Pixel 8 · Dar es Salaam', 'Samsung A54 · Arusha', 'TV Box · Mwanza']
    const pick = devices[Math.floor(Math.random() * devices.length)]
    const row = {
      id: newId(),
      deviceLabel: pick,
      requestedAt: new Date().toISOString(),
      status: 'pending',
    }
    const ok = Math.random() > 0.12
    const next = appendLog(`Incoming transfer request from ${pick}`)({
      ...cfg,
      pending: [row, ...(cfg.pending || [])].slice(0, 50),
    })
    try {
      const saved = await putDeviceControlSettings(next)
      setCfg(saved)
      await appendSecurityLog({
        actor: pick,
        eventType: 'Code transfer',
        status: ok ? 'completed' : 'failed',
        detail: `pending id ${String(row.id).slice(0, 8)} · handshake ${ok ? 'OK' : 'TIMEOUT'}`,
      })
      showFlash('success', 'Simulated pending request added.')
    } catch (err) {
      showToast('error', err?.message || 'Request failed')
    }
  }, [cfg, appendLog])

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
                <p className="text-sm font-medium text-slate-200">Transfer mode</p>
                <p className="text-xs text-slate-500">
                  Confirmation requires user approval; manual is admin-only path.
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
            <button
              type="button"
              onClick={simulatePending}
              className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-5 py-3 text-sm font-semibold text-amber-100 hover:bg-amber-500/20"
            >
              Simulate incoming request
            </button>
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
                        No pending requests.
                      </td>
                    </tr>
                  ) : (
                    cfg.pending.map((p) => (
                      <tr key={p.id} className="border-b border-slate-800/80">
                        <td className="px-4 py-3 text-slate-200">{p.deviceLabel}</td>
                        <td className="px-4 py-3 text-slate-400">
                          {new Date(p.requestedAt).toLocaleString()}
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
                        {new Date(l.at).toLocaleString()}
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
