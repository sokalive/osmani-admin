import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  Ban,
  Clock,
  CreditCard,
  History,
  Loader2,
  RefreshCw,
  Smartphone,
  User,
  X,
  Wrench,
} from 'lucide-react'
import { useToast } from '../context/ToastContext.jsx'
import {
  investigateCustomer,
  getUsersIntelligenceList,
  getUsersIntelligenceDetail,
  postUsersIntelligenceBlock,
  postUsersIntelligenceUnblock,
  postCustomerInvestigationRefreshSubscription,
} from '../lib/api'
import { formatAdminDateTime, formatAdminRemainingFromExpiry } from '../lib/formatAdminDateTime'
import { formatTsh } from '../lib/formatMoney'

const DRAWER_TABS = [
  { id: 'general', label: 'General', icon: User },
  { id: 'subscription', label: 'Subscription', icon: CreditCard },
  { id: 'payments', label: 'Payments', icon: CreditCard },
  { id: 'failed', label: 'Failed', icon: Ban },
  { id: 'usage', label: 'App Usage', icon: Activity },
  { id: 'logins', label: 'Login History', icon: History },
  { id: 'devices', label: 'Devices', icon: Smartphone },
  { id: 'timeline', label: 'Timeline', icon: Clock },
  { id: 'actions', label: 'Admin Actions', icon: Wrench },
]

function InfoCard({ title, children }) {
  return (
    <section className="rounded-2xl border border-slate-700/60 bg-[#0b1220]/80 p-5 ring-1 ring-white/[0.03]">
      {title ? (
        <h3 className="mb-4 text-xs font-bold uppercase tracking-wider text-slate-400">{title}</h3>
      ) : null}
      {children}
    </section>
  )
}

function InfoGrid({ rows }) {
  return (
    <dl className="grid gap-3 sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label} className="rounded-xl border border-slate-800/80 bg-slate-900/40 px-3 py-2.5">
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
          <dd className="mt-0.5 break-all text-sm text-slate-100">{value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  )
}

function DataTable({ columns, rows, empty = 'No records.' }) {
  if (!rows?.length) {
    return <p className="py-6 text-center text-sm text-slate-500">{empty}</p>
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-800/80">
      <table className="w-full min-w-[720px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-slate-700/80 bg-slate-900/60 text-[10px] uppercase tracking-wide text-slate-400">
            {columns.map((c) => (
              <th key={c.key} className="px-3 py-2.5 font-semibold">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.id || row.order_id || i} className="border-b border-slate-800/60 hover:bg-slate-900/40">
              {columns.map((c) => (
                <td key={c.key} className="px-3 py-2.5 text-slate-300">
                  {c.render ? c.render(row) : (row[c.key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function statusPill(status) {
  const s = String(status || '').toLowerCase()
  let cls = 'bg-slate-500/20 text-slate-200 ring-slate-400/30'
  if (s === 'completed' || s === 'active' || s === 'success') cls = 'bg-emerald-500/20 text-emerald-200 ring-emerald-400/40'
  else if (s === 'failed' || s === 'expired' || s === 'blocked') cls = 'bg-red-500/20 text-red-200 ring-red-400/40'
  else if (s === 'pending') cls = 'bg-amber-500/20 text-amber-200 ring-amber-400/40'
  else if (s === 'refunded') cls = 'bg-purple-500/20 text-purple-200 ring-purple-400/40'
  return (
    <span className={`inline-flex rounded-lg px-2 py-0.5 text-[10px] font-bold uppercase ring-1 ${cls}`}>
      {String(status || '—').toUpperCase()}
    </span>
  )
}

function splitDateTime(iso) {
  if (!iso) return { date: '—', time: '—', month: '—', year: '—' }
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { date: String(iso), time: '—', month: '—', year: '—' }
  return {
    date: d.toLocaleDateString('en-GB'),
    time: d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    month: d.toLocaleString('en-GB', { month: 'long' }),
    year: String(d.getFullYear()),
  }
}

function buildTimeline(report, intelligence) {
  const events = []
  const push = (type, at, title, detail, tone = 'neutral') => {
    if (!at) return
    events.push({ type, at, title, detail, tone })
  }

  for (const p of report?.payments?.completed || []) {
    push('payment', p.created_at, 'Payment completed', `${formatTsh(p.amount)} · ${p.plan_name || 'plan'} · ${p.provider_label}`, 'success')
  }
  for (const p of report?.payments?.pending || []) {
    push('payment', p.created_at, 'Payment pending', `${formatTsh(p.amount)} · ${p.order_id}`, 'warn')
  }
  for (const p of report?.payments?.failed || []) {
    push('payment', p.created_at, 'Payment failed', p.last_provider_response || p.order_id, 'danger')
  }
  for (const s of [...(report?.subscriptions?.active || []), ...(report?.subscriptions?.expired || [])]) {
    push('subscription', s.started_at, 'Subscription started', s.device_id, 'neutral')
    if (s.expires_at) push('subscription', s.expires_at, 'Subscription expiry', s.status, 'neutral')
  }
  for (const l of report?.audit_logs || []) {
    const t = String(l.event_type || '').toLowerCase()
    let tone = 'neutral'
    if (t.includes('block')) tone = 'danger'
    if (t.includes('unblock') || t.includes('repair')) tone = 'success'
    if (t.includes('transfer') || t.includes('migration')) tone = 'warn'
    if (t.includes('login')) tone = 'neutral'
    push('audit', l.created_at, l.event_type || 'Event', l.detail || l.status, tone)
  }
  for (const l of intelligence?.loginActivity || []) {
    push('login', l.created_at, 'App login', `${l.event_type || 'login'} · ${l.ip_address || ''}`, 'neutral')
  }
  for (const t of intelligence?.packageTransferHistory || []) {
    push('transfer', t.created_at, 'Package transfer out', t.target_device_id, 'warn')
  }
  for (const t of intelligence?.receivedTransfers || []) {
    push('transfer', t.created_at, 'Package transfer in', t.source_device_id, 'warn')
  }

  return events
    .filter((e) => e.at)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
}

function BlockConfirmDialog({ open, loading, reason, onReason, onConfirm, onCancel }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[140] flex items-center justify-center p-4">
      <button type="button" className="absolute inset-0 bg-black/80" aria-label="Close" onClick={loading ? undefined : onCancel} />
      <div className="relative w-full max-w-md rounded-2xl border border-red-500/30 bg-[#0f172a] p-6 shadow-2xl">
        <h3 className="text-lg font-bold text-white">Block user</h3>
        <p className="mt-2 text-sm text-slate-400">Reason is required and will be written to the audit log.</p>
        <textarea
          value={reason}
          onChange={(e) => onReason(e.target.value)}
          rows={3}
          placeholder="Reason for block…"
          className="mt-4 w-full rounded-xl border border-slate-600 bg-[#0a0e16] px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-[#f5b301]/50 focus:outline-none"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" disabled={loading} onClick={onCancel} className="rounded-xl border border-slate-600 px-4 py-2 text-sm text-slate-300">
            Cancel
          </button>
          <button
            type="button"
            disabled={loading || !reason.trim()}
            onClick={onConfirm}
            className="inline-flex items-center gap-2 rounded-xl border border-red-500/50 bg-red-600/20 px-4 py-2 text-sm font-semibold text-red-200 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Block user
          </button>
        </div>
      </div>
    </div>
  )
}

export default function UserProfileDrawer({ row, tab, onClose, onEditSubscription }) {
  const { showToast } = useToast()
  const [activeTab, setActiveTab] = useState('general')
  const [loading, setLoading] = useState(true)
  const [report, setReport] = useState(null)
  const [intelligence, setIntelligence] = useState(null)
  const [registryId, setRegistryId] = useState(null)
  const [actionBusy, setActionBusy] = useState(null)
  const [blockOpen, setBlockOpen] = useState(false)
  const [blockReason, setBlockReason] = useState('')
  const [visible, setVisible] = useState(false)

  const deviceId = String(row?.device_id ?? '')
  const searchParams = useMemo(
    () => ({
      device_id: deviceId || undefined,
      phone: row?.phone_number || undefined,
      order_id: row?.order_id || undefined,
      transaction_id: row?.order_id || undefined,
    }),
    [deviceId, row?.phone_number, row?.order_id],
  )

  const load = useCallback(async () => {
    if (!deviceId && !row?.phone_number && !row?.order_id) return
    setLoading(true)
    try {
      const inv = await investigateCustomer(searchParams)
      setReport(inv?.ok ? inv : null)

      let intelDetail = null
      let regId = null
      const q = deviceId || row?.phone_number || row?.order_id
      if (q) {
        const list = await getUsersIntelligenceList(q)
        const match =
          (list?.items || []).find((x) => String(x.deviceId) === deviceId) || (list?.items || [])[0]
        if (match?.id) {
          regId = match.id
          const detail = await getUsersIntelligenceDetail(match.id)
          if (detail?.registry || detail?.device) intelDetail = detail
        }
      }
      setRegistryId(regId)
      setIntelligence(intelDetail)
    } catch (e) {
      showToast('error', e?.message || 'Could not load user profile')
    } finally {
      setLoading(false)
    }
  }, [deviceId, row?.phone_number, row?.order_id, searchParams, showToast])

  useEffect(() => {
    if (!row) return
    setActiveTab('general')
    requestAnimationFrame(() => setVisible(true))
    void load()
  }, [row, load])

  useEffect(() => {
    if (!row) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setVisible(false)
        window.setTimeout(() => onClose?.(), 280)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [row, onClose])

  function handleClose() {
    setVisible(false)
    window.setTimeout(() => onClose?.(), 280)
  }

  const primaryDevice = report?.devices?.find((d) => d.device_id === deviceId) || report?.devices?.[0]
  const primarySub =
    report?.subscriptions?.active?.find((s) => s.device_id === deviceId) ||
    report?.subscriptions?.active?.[0] ||
    report?.subscriptions?.expired?.find((s) => s.device_id === deviceId)
  const reg = intelligence?.registry
  const dev = intelligence?.device
  const isBlocked = primaryDevice?.access?.blocked_now || reg?.status === 'blocked'
  const timeline = useMemo(() => buildTimeline(report, intelligence), [report, intelligence])

  const allPayments = useMemo(() => {
    const rows = [
      ...(report?.payments?.completed || []).map((p) => ({ ...p, _bucket: 'completed' })),
      ...(report?.payments?.pending || []).map((p) => ({ ...p, _bucket: 'pending' })),
      ...(report?.payments?.failed || []).map((p) => ({ ...p, _bucket: 'failed' })),
    ]
    return rows.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
  }, [report])

  const subscriptionHistory = useMemo(() => {
    const subs = [...(report?.subscriptions?.active || []), ...(report?.subscriptions?.expired || [])]
    const completed = report?.payments?.completed || []
    return subs.map((s) => {
      const related = completed.filter((p) => p.device_id === s.device_id)
      return {
        ...s,
        renew_count: related.length,
        plan_name: related[0]?.plan_name || '—',
        price: related[0]?.amount,
      }
    })
  }, [report])

  async function runBlock() {
    if (!registryId || !blockReason.trim()) return
    setActionBusy('block')
    try {
      await postUsersIntelligenceBlock(registryId, { reason: blockReason.trim() })
      showToast('success', 'User blocked')
      setBlockOpen(false)
      setBlockReason('')
      await load()
    } catch (e) {
      showToast('error', e?.message || 'Block failed')
    } finally {
      setActionBusy(null)
    }
  }

  async function runUnblock() {
    if (!registryId) {
      showToast('error', 'No intelligence registry record for this device')
      return
    }
    setActionBusy('unblock')
    try {
      await postUsersIntelligenceUnblock(registryId, {})
      showToast('success', 'User unblocked')
      await load()
    } catch (e) {
      showToast('error', e?.message || 'Unblock failed')
    } finally {
      setActionBusy(null)
    }
  }

  async function runRefreshSubscription() {
    if (!deviceId) return
    setActionBusy('refresh')
    try {
      await postCustomerInvestigationRefreshSubscription({ device_id: deviceId })
      showToast('success', 'Subscription refreshed')
      await load()
    } catch (e) {
      showToast('error', e?.message || 'Refresh failed')
    } finally {
      setActionBusy(null)
    }
  }

  if (!row) return null

  return (
    <>
      <div
        className={`fixed inset-0 z-[120] bg-black/70 backdrop-blur-sm transition-opacity duration-300 ${visible ? 'opacity-100' : 'opacity-0'}`}
        onClick={handleClose}
        aria-hidden
      />
      <aside
        className={`fixed inset-y-0 right-0 z-[130] flex w-full flex-col border-l border-slate-700/60 bg-[#0B0F1A] shadow-2xl transition-transform duration-300 ease-out sm:w-[70%] ${visible ? 'translate-x-0' : 'translate-x-full'}`}
        role="dialog"
        aria-modal="true"
        aria-label="User profile"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-800 px-6 py-5">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-widest text-[#f5b301]/80">User profile</p>
            <h2 className="mt-1 truncate font-mono text-lg font-bold text-white">{deviceId || row.phone_number || 'User'}</h2>
            <p className="mt-1 text-sm text-slate-400">
              {primarySub?.active_now ? (
                <span className="text-emerald-300">Active</span>
              ) : (
                <span className="text-slate-500">Inactive / expired</span>
              )}
              {isBlocked ? <span className="ml-2 text-red-300">· Blocked</span> : null}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="rounded-xl border border-slate-600 p-2.5 text-slate-300 hover:bg-slate-800 disabled:opacity-50"
              aria-label="Refresh profile"
            >
              <RefreshCw className={`h-5 w-5 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={handleClose}
              className="rounded-xl border border-slate-600 p-2.5 text-slate-300 hover:bg-slate-800"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </header>

        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-slate-800 px-4 py-2 custom-scrollbar">
          {DRAWER_TABS.map((t) => {
            const Icon = t.icon
            const active = activeTab === t.id
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveTab(t.id)}
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition-colors ${
                  active
                    ? 'bg-[#f5b301]/15 text-amber-100 ring-1 ring-[#f5b301]/35'
                    : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {t.label}
              </button>
            )
          })}
        </nav>

        <div className="custom-scrollbar flex-1 overflow-y-auto px-6 py-6">
          {loading && !report ? (
            <div className="flex items-center justify-center gap-2 py-24 text-slate-400">
              <Loader2 className="h-6 w-6 animate-spin" />
              Loading profile…
            </div>
          ) : (
            <div className="mx-auto flex max-w-5xl flex-col gap-5 pb-16">
              {activeTab === 'general' ? (
                <InfoCard title="General">
                  <InfoGrid
                    rows={[
                      ['Full phone', row.phone_number || primaryDevice?.intelligence?.phone_number || report?.customer?.phone_normalized],
                      ['Device ID', deviceId],
                      ['User name', reg?.userId || intelligence?.account?.userId || '—'],
                      ['Package', primarySub ? (subscriptionHistory[0]?.plan_name || 'Active plan') : '—'],
                      ['Current status', primarySub?.status || primaryDevice?.access?.status || '—'],
                      [
                        'Remaining days',
                        primarySub?.expires_at
                          ? formatAdminRemainingFromExpiry(primarySub.expires_at, new Date())
                          : '—',
                      ],
                      ['Expiry', formatAdminDateTime(primarySub?.expires_at)],
                      ['Started', formatAdminDateTime(primarySub?.started_at)],
                      ['Created', formatAdminDateTime(dev?.firstSeenAt || primarySub?.started_at)],
                      ['Last active', formatAdminDateTime(dev?.lastSeenAt || intelligence?.loginActivity?.[0]?.created_at)],
                    ]}
                  />
                </InfoCard>
              ) : null}

              {activeTab === 'subscription' ? (
                <>
                  <InfoCard title="Current package">
                    <InfoGrid
                      rows={[
                        ['Status', primarySub?.status],
                        ['Transaction', primarySub?.transaction_id],
                        ['Started', formatAdminDateTime(primarySub?.started_at)],
                        ['Expiry', formatAdminDateTime(primarySub?.expires_at)],
                        ['Remaining', formatAdminRemainingFromExpiry(primarySub?.expires_at, new Date())],
                      ]}
                    />
                  </InfoCard>
                  <InfoCard title="Subscription history">
                    <DataTable
                      empty="No subscription records."
                      columns={[
                        { key: 'plan_name', label: 'Package' },
                        { key: 'price', label: 'Price', render: (r) => (r.price != null ? formatTsh(r.price) : '—') },
                        { key: 'started_at', label: 'Start', render: (r) => formatAdminDateTime(r.started_at) },
                        { key: 'expires_at', label: 'Expiry', render: (r) => formatAdminDateTime(r.expires_at) },
                        {
                          key: 'remaining',
                          label: 'Remaining',
                          render: (r) => formatAdminRemainingFromExpiry(r.expires_at, new Date()),
                        },
                        { key: 'renew_count', label: 'Renew count' },
                        { key: 'status', label: 'Status', render: (r) => statusPill(r.status) },
                      ]}
                      rows={subscriptionHistory}
                    />
                  </InfoCard>
                  {intelligence?.manualGrants?.length ? (
                    <InfoCard title="Extension history (manual grants)">
                      <DataTable
                        columns={[
                          { key: 'duration_days', label: 'Days added' },
                          { key: 'created_at', label: 'Granted', render: (r) => formatAdminDateTime(r.created_at) },
                        ]}
                        rows={intelligence.manualGrants}
                      />
                    </InfoCard>
                  ) : null}
                </>
              ) : null}

              {activeTab === 'payments' ? (
                <InfoCard title="Payment history">
                  <DataTable
                    empty="No payments."
                    columns={[
                      {
                        key: 'created_at',
                        label: 'Date / time',
                        render: (r) => {
                          const p = splitDateTime(r.created_at)
                          return (
                            <span>
                              {p.date} {p.time}
                              <span className="block text-[10px] text-slate-500">
                                {p.month} {p.year}
                              </span>
                            </span>
                          )
                        },
                      },
                      { key: 'phone', label: 'Phone' },
                      { key: 'provider_label', label: 'Provider' },
                      { key: 'provider_reference', label: 'Reference' },
                      { key: 'amount', label: 'Amount', render: (r) => formatTsh(r.amount) },
                      { key: 'status', label: 'Status', render: (r) => statusPill(r.status) },
                      { key: 'order_id', label: 'Transaction ID' },
                      { key: 'plan_name', label: 'Duration / plan' },
                    ]}
                    rows={allPayments.filter((p) => p._bucket !== 'failed')}
                  />
                </InfoCard>
              ) : null}

              {activeTab === 'failed' ? (
                <InfoCard title="Failed payments">
                  <DataTable
                    empty="No failed payments."
                    columns={[
                      { key: 'created_at', label: 'Time', render: (r) => formatAdminDateTime(r.created_at) },
                      { key: 'phone', label: 'Phone' },
                      { key: 'amount', label: 'Amount', render: (r) => formatTsh(r.amount) },
                      { key: 'provider_reference', label: 'Reference' },
                      { key: 'order_id', label: 'Transaction ID' },
                      {
                        key: 'last_provider_response',
                        label: 'Reason / gateway response',
                        render: (r) => r.last_provider_response || '—',
                      },
                      { key: 'status', label: 'Status', render: (r) => statusPill(r.status) },
                    ]}
                    rows={report?.payments?.failed || []}
                  />
                </InfoCard>
              ) : null}

              {activeTab === 'usage' ? (
                <InfoCard title="App usage">
                  <InfoGrid
                    rows={[
                      ['First login', formatAdminDateTime(dev?.firstSeenAt)],
                      ['Last login', formatAdminDateTime(intelligence?.loginActivity?.[0]?.created_at || dev?.lastSeenAt)],
                      ['Total logins', intelligence?.loginActivity?.length ?? '—'],
                      [
                        "Today's logins",
                        intelligence?.loginActivity?.filter((l) => {
                          const d = new Date(l.created_at)
                          const n = new Date()
                          return d.toDateString() === n.toDateString()
                        }).length ?? 0,
                      ],
                      ['Watch time', intelligence?.usage?.watchTime || '—'],
                      ['Channels watched', intelligence?.usage?.channelsWatched ?? '—'],
                      ['Most watched channel', intelligence?.usage?.topChannel || '—'],
                      ['Current device', [dev?.deviceBrand, dev?.deviceModel].filter(Boolean).join(' ') || '—'],
                      ['Android version', dev?.osVersion],
                      ['App version', dev?.appVersion],
                      ['Build version', dev?.buildVersion || dev?.appVersion],
                      ['IP', intelligence?.loginActivity?.[0]?.ip_address],
                      ['Country', intelligence?.loginActivity?.[0]?.country],
                      ['Region', intelligence?.loginActivity?.[0]?.region],
                      ['Timezone', intelligence?.loginActivity?.[0]?.timezone],
                    ]}
                  />
                </InfoCard>
              ) : null}

              {activeTab === 'logins' ? (
                <InfoCard title="Login history">
                  <DataTable
                    empty="No login events."
                    columns={[
                      {
                        key: 'created_at',
                        label: 'Date',
                        render: (r) => {
                          const p = splitDateTime(r.created_at)
                          return `${p.date} · ${p.month} ${p.year}`
                        },
                      },
                      { key: 'time', label: 'Time', render: (r) => splitDateTime(r.created_at).time },
                      { key: 'device_model', label: 'Device', render: (r) => r.device_model || dev?.deviceModel || '—' },
                      { key: 'app_version', label: 'Version' },
                      { key: 'ip_address', label: 'IP' },
                      { key: 'country', label: 'Country' },
                    ]}
                    rows={intelligence?.loginActivity || []}
                  />
                </InfoCard>
              ) : null}

              {activeTab === 'devices' ? (
                <>
                  <InfoCard title="Devices">
                    <div className="space-y-3">
                      {(report?.devices || []).map((d) => (
                        <div
                          key={d.device_id}
                          className={`rounded-xl border p-4 ${d.device_id === deviceId ? 'border-[#f5b301]/40 bg-amber-500/5' : 'border-slate-800 bg-slate-900/30'}`}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="font-mono text-sm text-cyan-200">{d.device_id}</p>
                            {d.device_id === deviceId ? (
                              <span className="rounded-lg bg-[#f5b301]/15 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-200">
                                Current
                              </span>
                            ) : null}
                          </div>
                          {d.install_instances?.length ? (
                            <p className="mt-2 text-xs text-slate-500">
                              Install instance: {d.install_instances.map((x) => x.install_instance_id).join(', ') || '—'}
                            </p>
                          ) : null}
                          {d.access ? (
                            <p className="mt-1 text-xs text-slate-400">
                              Access: {d.access.active_now ? 'active' : 'inactive'}
                              {d.access.blocked_now ? ' · blocked' : ''}
                              {d.access.expires_at ? ` · expires ${formatAdminDateTime(d.access.expires_at)}` : ''}
                            </p>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </InfoCard>
                  <InfoCard title="Device identifiers">
                    <InfoGrid
                      rows={[
                        ['Render device', dev?.deviceId || deviceId],
                        ['VPS device', deviceId],
                        ['Install instance', primaryDevice?.install_instances?.[0]?.install_instance_id],
                        ['Android ID', dev?.androidId],
                        ['Stable hardware ID', dev?.deviceFingerprint],
                      ]}
                    />
                  </InfoCard>
                  {(intelligence?.packageTransferHistory?.length || intelligence?.receivedTransfers?.length) ? (
                    <InfoCard title="Transfer & migration history">
                      <DataTable
                        columns={[
                          { key: 'transfer_code', label: 'Code' },
                          { key: 'source_device_id', label: 'Source' },
                          { key: 'target_device_id', label: 'Target' },
                          { key: 'status', label: 'Status' },
                          { key: 'created_at', label: 'When', render: (r) => formatAdminDateTime(r.created_at) },
                        ]}
                        rows={[
                          ...(intelligence?.packageTransferHistory || []).map((r) => ({ ...r, _dir: 'out' })),
                          ...(intelligence?.receivedTransfers || []).map((r) => ({ ...r, _dir: 'in' })),
                        ]}
                      />
                    </InfoCard>
                  ) : null}
                </>
              ) : null}

              {activeTab === 'timeline' ? (
                <InfoCard title="Activity timeline">
                  {timeline.length === 0 ? (
                    <p className="py-8 text-center text-sm text-slate-500">No events yet.</p>
                  ) : (
                    <ol className="relative border-l border-slate-700/80 pl-6">
                      {timeline.map((ev, i) => {
                        const toneDot =
                          ev.tone === 'success'
                            ? 'bg-emerald-400'
                            : ev.tone === 'danger'
                              ? 'bg-red-400'
                              : ev.tone === 'warn'
                                ? 'bg-amber-400'
                                : 'bg-slate-500'
                        return (
                          <li key={`${ev.at}-${ev.type}-${i}`} className="mb-6 ml-2">
                            <span className={`absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-[#0B0F1A] ${toneDot}`} />
                            <time className="text-xs text-slate-500">{formatAdminDateTime(ev.at)}</time>
                            <p className="mt-0.5 text-sm font-semibold text-white">{ev.title}</p>
                            {ev.detail ? <p className="mt-0.5 text-xs text-slate-400">{ev.detail}</p> : null}
                          </li>
                        )
                      })}
                    </ol>
                  )}
                </InfoCard>
              ) : null}

              {activeTab === 'actions' ? (
                <InfoCard title="Admin actions">
                  <div className="grid gap-2 sm:grid-cols-2">
                    {[
                      { id: 'block', label: 'Block user', tone: 'red', run: () => setBlockOpen(true), hide: isBlocked },
                      { id: 'unblock', label: 'Unblock user', tone: 'green', run: () => void runUnblock(), hide: !isBlocked },
                      { id: 'extend', label: 'Extend package', run: () => onEditSubscription?.(row) },
                      { id: 'reduce', label: 'Reduce package', run: () => onEditSubscription?.(row) },
                      { id: 'transfer', label: 'Transfer package', run: () => showToast('info', 'Use Customer Investigation force-transfer for phone-based transfer') },
                      { id: 'reset', label: 'Reset device', run: () => showToast('info', 'Contact support — device reset requires backend action') },
                      { id: 'verify', label: 'Force verify', run: () => showToast('info', 'Use payment reconcile on latest order') },
                      { id: 'refresh', label: 'Force refresh', run: () => void runRefreshSubscription() },
                      { id: 'repair-sub', label: 'Repair subscription', run: () => void runRefreshSubscription() },
                      { id: 'repair-mig', label: 'Repair migration', run: () => showToast('info', 'Use Customer Investigation for migration repair') },
                      { id: 'logs', label: 'View logs', run: () => setActiveTab('timeline') },
                    ]
                      .filter((a) => !a.hide)
                      .map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          disabled={Boolean(actionBusy)}
                          onClick={a.run}
                          className={`rounded-xl border px-4 py-3 text-left text-sm font-semibold transition-colors disabled:opacity-50 ${
                            a.tone === 'red'
                              ? 'border-red-500/40 bg-red-950/30 text-red-200 hover:bg-red-500/15'
                              : a.tone === 'green'
                                ? 'border-emerald-500/40 bg-emerald-950/30 text-emerald-200 hover:bg-emerald-500/15'
                                : 'border-slate-600 bg-slate-900/40 text-slate-200 hover:bg-slate-800/60'
                          }`}
                        >
                          {actionBusy === a.id ? <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> : null}
                          {a.label}
                        </button>
                      ))}
                  </div>
                  {report?.suggested_actions?.length ? (
                    <div className="mt-6 border-t border-slate-800 pt-4">
                      <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Suggested repairs</p>
                      <div className="flex flex-col gap-2">
                        {report.suggested_actions.map((a, i) => (
                          <div key={`${a.action}-${i}`} className="rounded-xl border border-slate-700/50 bg-slate-900/30 px-3 py-2 text-sm">
                            <p className="font-medium text-white">{a.label}</p>
                            <p className="text-xs text-slate-500">{a.reason}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </InfoCard>
              ) : null}
            </div>
          )}
        </div>
      </aside>

      <BlockConfirmDialog
        open={blockOpen}
        loading={actionBusy === 'block'}
        reason={blockReason}
        onReason={setBlockReason}
        onConfirm={() => void runBlock()}
        onCancel={() => {
          setBlockOpen(false)
          setBlockReason('')
        }}
      />
    </>
  )
}
