import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Activity,
  ListChecks,
  Save,
  Shield,
  ShieldAlert,
  Trash2,
  UserX,
} from 'lucide-react'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import {
  deleteSecurityAlert,
  getSecuritySuite,
  postAdminForceTransferPhone,
  postSubscriptionRevoke,
  postSecurityAlertsBulkDelete,
  postSecuritySuiteRestoreWhitelist,
  syncStreamUrl,
  putSecuritySuite,
} from '../lib/api'
import { formatReadableDateTime } from '../lib/formatTxDisplay'

function newId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `a-${Date.now()}`
}

function normalizeSuite(raw) {
  const base = {
    protectionMode: 'manual',
    whitelist: [],
    blockedUsers: [],
    alerts: [],
  }
  if (!raw || typeof raw !== 'object') return base
  return {
    protectionMode: raw.protectionMode === 'automatic' ? 'automatic' : 'manual',
    whitelist: Array.isArray(raw.whitelist) ? raw.whitelist : [],
    blockedUsers: Array.isArray(raw.blockedUsers) ? raw.blockedUsers : [],
    alerts: Array.isArray(raw.alerts)
      ? raw.alerts.map((a) => ({
          ...a,
          actor: typeof a.actor === 'string' ? a.actor.trim() : '',
        }))
      : [],
  }
}

function deviceIdFromAlert(alert) {
  const actor = typeof alert.actor === 'string' ? alert.actor.trim() : ''
  return actor || ''
}

function computeAlertStats(alerts) {
  const activeAlerts = alerts.filter((a) => a.status === 'active').length
  const suspiciousPatterns = alerts.filter(
    (a) => a.status === 'active' && a.kind === 'pattern',
  ).length
  return { activeAlerts, suspiciousPatterns }
}

function SecurityAlertsPage() {
  const navigate = useNavigate()
  const { showToast } = useToast()
  const [suite, setSuite] = useState(() => normalizeSuite(null))
  const [protectionDraft, setProtectionDraft] = useState('manual')
  const [whitelistInput, setWhitelistInput] = useState('')
  const [savedFlash, setSavedFlash] = useState(false)
  const [selectedAlerts, setSelectedAlerts] = useState(() => new Set())

  const load = useCallback(async () => {
    try {
      const s = await getSecuritySuite()
      const n = normalizeSuite(s)
      setSuite(n)
      setProtectionDraft(n.protectionMode)
    } catch (e) {
      showToast('error', e?.message || 'Could not load security suite')
    }
  }, [showToast])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    const es = new EventSource(syncStreamUrl(['config']))
    const onRefresh = () => {
      void load()
    }
    es.addEventListener('security_event_logged', onRefresh)
    es.addEventListener('security_alerts_changed', onRefresh)
    es.addEventListener('security_logs_changed', onRefresh)
    es.addEventListener('security_suite_changed', onRefresh)
    es.addEventListener('transfer_requested', onRefresh)
    es.addEventListener('transfer_completed', onRefresh)
    es.addEventListener('transfer_rejected', onRefresh)
    es.addEventListener('subscription_revoked', onRefresh)
    return () => es.close()
  }, [load])

  const stats = useMemo(() => {
    const { activeAlerts, suspiciousPatterns } = computeAlertStats(suite.alerts)
    return {
      activeAlerts,
      blockedUsers: suite.blockedUsers.length,
      suspiciousPatterns,
    }
  }, [suite.alerts, suite.blockedUsers])

  const persist = useCallback(
    async (next) => {
      try {
        const saved = normalizeSuite(await putSecuritySuite(next))
        setSuite(saved)
        setProtectionDraft(saved.protectionMode)
        return true
      } catch (e) {
        showToast('error', e?.message || 'Save failed')
        return false
      }
    },
    [showToast],
  )

  const saveProtectionSettings = useCallback(async () => {
    const ok = await persist({ ...suite, protectionMode: protectionDraft })
    if (ok) {
      setSavedFlash(true)
      window.setTimeout(() => setSavedFlash(false), 2400)
    }
  }, [persist, suite, protectionDraft])

  const deleteAllAlerts = useCallback(async () => {
    if (
      !window.confirm(
        'Delete all current alerts? This clears the alert list on the server.',
      )
    ) {
      return
    }
    try {
      const out = await postSecurityAlertsBulkDelete({ all: true })
      if (typeof out?.deleted === 'number' && out.deleted === 0 && suite.alerts.length > 0) {
        showToast('error', 'Delete-all completed with 0 rows affected.')
        return
      }
      setSelectedAlerts(new Set())
      await load()
    } catch (e) {
      showToast('error', e?.message || 'Delete all alerts failed')
    }
    setSelectedAlerts(new Set())
  }, [load, showToast])

  const deleteOne = useCallback(
    async (id) => {
      try {
        await deleteSecurityAlert(id)
        setSelectedAlerts((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
        await load()
      } catch (e) {
        showToast('error', e?.message || 'Delete alert failed')
      }
    },
    [load, showToast],
  )

  const toggleAlert = useCallback((id) => {
    setSelectedAlerts((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleAllAlerts = useCallback(() => {
    setSelectedAlerts((prev) => {
      if (prev.size === suite.alerts.length) return new Set()
      return new Set(suite.alerts.map((a) => a.id))
    })
  }, [suite.alerts])

  const deleteSelectedAlerts = useCallback(async () => {
    if (selectedAlerts.size === 0) return
    if (!window.confirm(`Delete ${selectedAlerts.size} selected alerts?`)) return
    try {
      const out = await postSecurityAlertsBulkDelete({ ids: Array.from(selectedAlerts) })
      if (!out?.deleted) {
        showToast('error', 'No alerts were deleted. Refresh and retry.')
        return
      }
      setSelectedAlerts(new Set())
      await load()
    } catch (e) {
      showToast('error', e?.message || 'Delete selected alerts failed')
    }
  }, [load, selectedAlerts, showToast])

  const addWhitelist = useCallback(async () => {
    const v = whitelistInput.trim()
    if (!v) return
    const ok = await persist({
      ...suite,
      whitelist: [{ id: newId(), value: v }, ...suite.whitelist],
    })
    if (ok) setWhitelistInput('')
  }, [persist, suite, whitelistInput])

  const removeWhitelist = useCallback(
    async (id) => {
      await persist({
        ...suite,
        whitelist: suite.whitelist.filter((w) => w.id !== id),
      })
    },
    [persist, suite],
  )

  const persistBlock = useCallback(
    async (deviceId, reason) => {
      const id = String(deviceId ?? '').trim()
      if (!id) {
        showToast('error', 'No device id on this alert (actor empty).')
        return
      }
      const blockedUsers = [
        ...suite.blockedUsers.filter((b) => String(b.value ?? b.id) !== id),
        { id, value: id, reason },
      ]
      const ok = await persist({ ...suite, blockedUsers })
      if (ok) showToast('success', `Blocked · ${id.slice(0, 24)}${id.length > 24 ? '…' : ''}`)
    },
    [persist, showToast, suite],
  )

  const persistTrustDevice = useCallback(
    async (deviceId) => {
      const id = String(deviceId ?? '').trim()
      if (!id) {
        showToast('error', 'No device id on this alert (actor empty).')
        return
      }
      const whitelist = [...suite.whitelist.filter((w) => String(w.value ?? w.id) !== id)]
      whitelist.unshift({ id: newId(), value: id })
      const ok = await persist({ ...suite, whitelist })
      if (ok) showToast('success', `Trusted · ${id.slice(0, 24)}${id.length > 24 ? '…' : ''}`)
    },
    [persist, showToast, suite],
  )

  const handleForceFromAlert = useCallback(
    async (alertActor) => {
      const hinted = deviceIdFromAlert({ actor: alertActor })
      const paymentPhone =
        typeof window !== 'undefined'
          ? window.prompt('Nambari ya kulipia (payment phone)', '')
          : null
      const targetDeviceId =
        typeof window !== 'undefined' ? window.prompt('Device ID ya simu mpya', hinted || '') : null
      const phone = String(paymentPhone ?? '').trim()
      const target = String(targetDeviceId ?? '').trim()
      if (!phone || !target) return
      try {
        await postAdminForceTransferPhone({
          payment_phone: phone,
          target_device_id: target,
        })
        showToast('success', 'Force transfer completed.')
        await load()
      } catch (e) {
        showToast('error', e?.message || 'Force transfer failed')
      }
    },
    [load, showToast],
  )

  const restoreWhitelistDefaults = useCallback(async () => {
    try {
      const s = await postSecuritySuiteRestoreWhitelist()
      setSuite(normalizeSuite(s))
      setProtectionDraft(normalizeSuite(s).protectionMode)
    } catch (e) {
      showToast('error', e?.message || 'Restore failed')
    }
  }, [showToast])

  const handleRuntimeRevoke = useCallback(
    async (deviceId) => {
      const id = String(deviceId ?? '').trim()
      if (!id) {
        showToast('error', 'No device id on this alert (actor empty).')
        return
      }
      try {
        await postSubscriptionRevoke({ device_id: id })
        showToast('success', `Runtime revoked · ${id.slice(0, 24)}${id.length > 24 ? '…' : ''}`)
        await load()
      } catch (e) {
        showToast('error', e?.message || 'Runtime revoke failed')
      }
    },
    [load, showToast],
  )

  return (
    <>
      <Topbar />
      <main className="mt-6 flex min-h-0 flex-1 flex-col gap-8">
        <header>
          <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
            Security Alerts
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Backend-driven monitoring of suspicious runtime and device activity.
          </p>
        </header>

        <section className="flex flex-col gap-4 rounded-2xl border border-slate-700/60 bg-slate-950/40 p-5 ring-1 ring-white/[0.04] lg:flex-row lg:flex-wrap lg:items-center lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Protection mode
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setProtectionDraft('manual')}
                className={`rounded-xl px-4 py-2 text-sm font-bold uppercase tracking-wide transition-colors ${
                  protectionDraft === 'manual'
                    ? 'bg-gradient-to-r from-amber-400 to-yellow-500 text-slate-950 shadow-lg'
                    : 'border border-slate-600 bg-slate-900/60 text-slate-400 hover:border-slate-500'
                }`}
              >
                Manual
              </button>
              <button
                type="button"
                onClick={() => setProtectionDraft('automatic')}
                className={`rounded-xl px-4 py-2 text-sm font-bold uppercase tracking-wide transition-colors ${
                  protectionDraft === 'automatic'
                    ? 'bg-gradient-to-r from-amber-400 to-yellow-500 text-slate-950 shadow-lg'
                    : 'border border-slate-600 bg-slate-900/60 text-slate-400 hover:border-slate-500'
                }`}
              >
                Automatic
              </button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3 lg:ml-auto">
            {savedFlash ? (
              <span className="text-xs font-semibold text-emerald-300">Settings saved</span>
            ) : null}
            <button
              type="button"
              onClick={saveProtectionSettings}
              className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-5 py-2.5 text-sm font-semibold text-emerald-100 hover:bg-emerald-500/20"
            >
              <Save className="h-4 w-4" />
              Save Settings
            </button>
            <button
              type="button"
              onClick={deleteAllAlerts}
              className="inline-flex items-center gap-2 rounded-xl border border-red-500/45 bg-red-500/15 px-5 py-2.5 text-sm font-semibold text-red-100 hover:bg-red-500/25"
            >
              <Trash2 className="h-4 w-4" />
              Delete All Alerts
            </button>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-700/60 bg-slate-950/40 ring-1 ring-white/[0.04]">
          <div className="border-b border-slate-800/80 px-5 py-4">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
              <Shield className="h-5 w-5 text-sky-400" />
              Trusted Whitelist ({suite.whitelist.length})
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Devices and addresses never auto-blocked while this list is honored.
            </p>
          </div>
          <div className="space-y-4 px-5 py-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                value={whitelistInput}
                onChange={(e) => setWhitelistInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addWhitelist()
                }}
                placeholder="Add IP, hostname, or device label…"
                className="min-w-0 flex-1 rounded-xl border border-slate-600/70 bg-slate-900/80 px-4 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-amber-500/60 focus:outline-none focus:ring-2 focus:ring-amber-500/25"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={addWhitelist}
                  className="rounded-xl bg-slate-800 px-4 py-2.5 text-sm font-semibold text-slate-100 hover:bg-slate-700"
                >
                  Add
                </button>
                <button
                  type="button"
                  onClick={restoreWhitelistDefaults}
                  className="rounded-xl border border-slate-600 px-4 py-2.5 text-sm font-medium text-slate-400 hover:bg-slate-800"
                >
                  Restore defaults
                </button>
              </div>
            </div>
            <ul className="grid gap-2 sm:grid-cols-2">
              {suite.whitelist.map((w) => (
                <li
                  key={w.id}
                  className="flex items-center justify-between gap-2 rounded-xl border border-slate-700/80 bg-slate-900/50 px-3 py-2.5"
                >
                  <span className="min-w-0 truncate font-mono text-sm text-slate-200">{w.value}</span>
                  <button
                    type="button"
                    onClick={() => removeWhitelist(w.id)}
                    className="shrink-0 rounded-lg border border-slate-600 px-2 py-1 text-[11px] font-semibold uppercase text-slate-400 hover:border-red-500/40 hover:text-red-200"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <article className="relative overflow-hidden rounded-2xl border border-red-500/35 bg-gradient-to-br from-red-950/45 to-slate-950 p-5 shadow-lg ring-1 ring-red-500/20">
            <div className="flex items-center justify-between gap-2">
              <ShieldAlert className="h-6 w-6 text-red-300" />
              <span className="rounded-md bg-red-500/25 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-100 ring-1 ring-red-400/40">
                Live
              </span>
            </div>
            <p className="mt-4 text-3xl font-extrabold tabular-nums text-white">{stats.activeAlerts}</p>
            <p className="mt-1 text-xs font-medium text-red-200/85">Active Alerts</p>
          </article>

          <article className="relative overflow-hidden rounded-2xl border border-amber-500/35 bg-gradient-to-br from-amber-950/40 to-slate-950 p-5 shadow-lg ring-1 ring-amber-500/20">
            <div className="flex items-center justify-between gap-2">
              <UserX className="h-6 w-6 text-amber-300" />
              <span className="rounded-md bg-amber-500/25 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-100 ring-1 ring-amber-400/40">
                Block
              </span>
            </div>
            <p className="mt-4 text-3xl font-extrabold tabular-nums text-white">{stats.blockedUsers}</p>
            <p className="mt-1 text-xs font-medium text-amber-200/85">Blocked Users</p>
          </article>

          <article className="relative overflow-hidden rounded-2xl border border-violet-500/35 bg-gradient-to-br from-violet-950/45 to-slate-950 p-5 shadow-lg ring-1 ring-violet-500/20">
            <div className="flex items-center justify-between gap-2">
              <Activity className="h-6 w-6 text-violet-300" />
              <span className="rounded-md bg-violet-500/25 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-100 ring-1 ring-violet-400/40">
                ML
              </span>
            </div>
            <p className="mt-4 text-3xl font-extrabold tabular-nums text-white">
              {stats.suspiciousPatterns}
            </p>
            <p className="mt-1 text-xs font-medium text-violet-200/85">Suspicious Patterns</p>
          </article>
        </section>

        <section className="rounded-2xl border border-slate-700/60 bg-slate-950/40 ring-1 ring-white/[0.04]">
          <div className="border-b border-slate-800/80 px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
                <ListChecks className="h-5 w-5 text-amber-400" />
                Alerts
              </h2>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={toggleAllAlerts}
                  className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:bg-slate-800"
                >
                  {selectedAlerts.size === suite.alerts.length && suite.alerts.length > 0
                    ? 'Unselect all'
                    : 'Select all'}
                </button>
                <button
                  type="button"
                  disabled={selectedAlerts.size === 0}
                  onClick={deleteSelectedAlerts}
                  className="inline-flex items-center gap-1 rounded-lg border border-red-500/35 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-200 disabled:opacity-40"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete selected ({selectedAlerts.size})
                </button>
              </div>
            </div>
          </div>
          <ul className="divide-y divide-slate-800/90">
            {suite.alerts.length === 0 ? (
              <li className="px-5 py-8 text-center text-sm text-slate-500">No alerts.</li>
            ) : (
              suite.alerts.map((a) => (
                <li
                  key={a.id}
                  className="flex flex-col gap-4 px-5 py-4 transition-colors hover:bg-slate-900/50 lg:flex-row lg:items-center lg:justify-between"
                >
                  <div className="min-w-0 flex-1">
                    <label className="mb-2 inline-flex items-center gap-2 text-xs text-slate-400">
                      <input
                        type="checkbox"
                        checked={selectedAlerts.has(a.id)}
                        onChange={() => toggleAlert(a.id)}
                        className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-amber-500 focus:ring-amber-500/40"
                      />
                      Select
                    </label>
                    <p className="font-semibold text-white">{a.title}</p>
                    <p className="mt-1 font-mono text-sm text-slate-400">{a.deviceOrIp}</p>
                    <p className="mt-1 text-xs text-slate-500">
                      {formatReadableDateTime(a.time || a.timestamp || a.createdAt)}
                    </p>
                  </div>
                  <div className="flex w-full min-w-[220px] flex-col gap-2 lg:max-w-xl lg:items-end">
                    <span className="inline-flex self-start rounded-lg px-3 py-1 text-[11px] font-bold uppercase tracking-wide ring-1 bg-red-500/20 text-red-200 ring-red-400/45 lg:self-end">
                      Active
                    </span>
                    <div className="flex w-full flex-wrap gap-1.5 lg:justify-end">
                      <button
                        type="button"
                        onClick={() => persistBlock(deviceIdFromAlert(a), 'Blocked by security alert')}
                        className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] font-semibold text-amber-100 hover:bg-amber-500/20"
                      >
                        Block Device
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteOne(a.id)}
                        className="rounded-lg border border-sky-500/35 bg-sky-500/10 px-2.5 py-1.5 text-[11px] font-semibold text-sky-100 hover:bg-sky-500/20"
                      >
                        Resolve Alert
                      </button>
                      <button
                        type="button"
                        onClick={() => handleForceFromAlert(a.actor)}
                        className="rounded-lg border border-violet-500/40 bg-violet-500/10 px-2.5 py-1.5 text-[11px] font-semibold text-violet-100 hover:bg-violet-500/20"
                      >
                        Force Transfer
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRuntimeRevoke(deviceIdFromAlert(a))}
                        className="rounded-lg border border-red-500/45 bg-red-500/15 px-2.5 py-1.5 text-[11px] font-semibold text-red-100 hover:bg-red-500/25"
                      >
                        Revoke Runtime
                      </button>
                      <button
                        type="button"
                        onClick={() => persistTrustDevice(deviceIdFromAlert(a))}
                        className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-[11px] font-semibold text-emerald-100 hover:bg-emerald-500/20"
                      >
                        Trust
                      </button>
                      <button
                        type="button"
                        onClick={() => navigate('/security-logs')}
                        className="rounded-lg border border-slate-600 bg-slate-900/70 px-2.5 py-1.5 text-[11px] font-semibold text-slate-200 hover:bg-slate-800"
                      >
                        View Logs
                      </button>
                    </div>
                  </div>
                </li>
              ))
            )}
          </ul>
        </section>
      </main>
    </>
  )
}

export default SecurityAlertsPage
