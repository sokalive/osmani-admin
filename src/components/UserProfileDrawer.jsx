import { useCallback, useEffect, useMemo, useState } from 'react'
/** Premium Swahili user profile drawer — UI parity with VPS admin. */
import {
  Activity,
  Ban,
  CheckCircle2,
  Clock,
  Copy,
  CreditCard,
  History,
  LayoutGrid,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Sparkles,
  User,
  X,
  Zap,
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

const TABS = [
  { id: 'muhtasari', label: 'Muhtasari', icon: LayoutGrid },
  { id: 'usajili', label: 'Usajili', icon: CreditCard },
  { id: 'malipo', label: 'Malipo', icon: CreditCard },
  { id: 'matumizi', label: 'Matumizi', icon: Activity },
  { id: 'vifaa', label: 'Vifaa', icon: Smartphone },
  { id: 'historia', label: 'Historia', icon: History },
]

const CARD =
  'flex h-full flex-col rounded-2xl border border-slate-700/45 bg-gradient-to-br from-[#0f172a]/95 via-[#0b1220]/90 to-[#060a12]/95 p-5 shadow-[0_16px_48px_rgba(0,0,0,0.35)] ring-1 ring-white/[0.04]'

function statusLabelSw(st) {
  const s = String(st ?? '').toLowerCase()
  if (s === 'active' || s === 'completed') return 'Imefanikiwa'
  if (s === 'pending') return 'Inasubiri'
  if (s === 'failed') return 'Imeshindwa'
  if (s === 'expired') return 'Imeisha'
  if (s === 'refunded') return 'Imerejeshwa'
  if (s === 'cancelled' || s === 'canceled') return 'Imefutwa'
  if (s === 'blocked') return 'Imezuiwa'
  return st || '—'
}

function StatusBadge({ status }) {
  const s = String(status || '').toLowerCase()
  let cls = 'bg-slate-500/20 text-slate-200 ring-slate-400/30'
  if (s === 'completed' || s === 'active' || s === 'success') cls = 'bg-emerald-500/25 text-emerald-100 ring-emerald-400/45'
  else if (s === 'failed' || s === 'expired' || s === 'blocked') cls = 'bg-red-500/25 text-red-100 ring-red-400/45'
  else if (s === 'pending') cls = 'bg-amber-500/25 text-amber-100 ring-amber-400/45'
  else if (s === 'refunded') cls = 'bg-purple-500/25 text-purple-100 ring-purple-400/45'
  else if (s === 'cancelled' || s === 'canceled') cls = 'bg-orange-500/25 text-orange-100 ring-orange-400/45'
  return (
    <span className={`inline-flex rounded-lg px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ring-1 ${cls}`}>
      {statusLabelSw(status)}
    </span>
  )
}

function splitDateTime(iso) {
  if (!iso) return { date: '—', time: '—', month: '—', year: '—' }
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { date: String(iso), time: '—', month: '—', year: '—' }
  return {
    date: d.toLocaleDateString('sw-TZ', { timeZone: 'Africa/Dar_es_Salaam' }),
    time: d.toLocaleTimeString('sw-TZ', {
      timeZone: 'Africa/Dar_es_Salaam',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }),
    month: d.toLocaleString('sw-TZ', { timeZone: 'Africa/Dar_es_Salaam', month: 'long' }),
    year: String(d.getFullYear()),
  }
}

function daysBetween(startIso, endIso) {
  if (!startIso || !endIso) return '—'
  const a = new Date(startIso)
  const b = new Date(endIso)
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return '—'
  return String(Math.max(0, Math.ceil((b.getTime() - a.getTime()) / 86400000)))
}

function initialsFrom(name, phone) {
  const n = String(name || '').trim()
  if (n && n !== '—') {
    const parts = n.split(/\s+/).filter(Boolean)
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
    return n.slice(0, 2).toUpperCase()
  }
  const p = String(phone || '').replace(/\D/g, '')
  return p.slice(-2) || 'OT'
}

function Metric({ label, value, large }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</p>
      <p className={`mt-1 break-words font-semibold text-white ${large ? 'text-xl' : 'text-base'}`}>{value ?? '—'}</p>
    </div>
  )
}

function PremiumTable({ columns, rows, empty = 'Hakuna rekodi.' }) {
  if (!rows?.length) {
    return <p className="py-10 text-center text-sm text-slate-500">{empty}</p>
  }
  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-700/40 bg-[#060a12]/60 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <table className="w-full min-w-[960px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-slate-700/60 bg-slate-900/50 text-[10px] font-bold uppercase tracking-wider text-slate-400">
            {columns.map((c) => (
              <th key={c.key} className="whitespace-nowrap px-4 py-3.5">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={row.id || row.order_id || row._key || i}
              className="border-b border-slate-800/50 transition-colors hover:bg-slate-900/35"
            >
              {columns.map((c) => (
                <td key={c.key} className="px-4 py-3.5 text-slate-300">
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

function ActionConfirmDialog({ open, config, loading, reason, onReason, onConfirm, onCancel }) {
  if (!open || !config) return null
  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center p-4">
      <button type="button" className="absolute inset-0 bg-black/85 backdrop-blur-sm" aria-label="Funga" onClick={loading ? undefined : onCancel} />
      <div className="relative w-full max-w-lg rounded-2xl border border-slate-600/50 bg-[#0f172a] p-6 shadow-2xl ring-1 ring-white/[0.06]">
        <h3 className="text-xl font-bold text-white">{config.title}</h3>
        <p className="mt-2 text-sm leading-relaxed text-slate-400">{config.message}</p>
        {config.requireReason ? (
          <textarea
            value={reason}
            onChange={(e) => onReason(e.target.value)}
            rows={3}
            placeholder="Andika sababu (itaandikwa kwenye kumbukumbu ya ukaguzi)…"
            className="mt-4 w-full rounded-xl border border-slate-600/70 bg-[#0a0e16] px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-[#f5b301]/50 focus:outline-none focus:ring-2 focus:ring-[#f5b301]/15"
          />
        ) : null}
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <button
            type="button"
            disabled={loading}
            onClick={onCancel}
            className="rounded-xl border border-slate-600 px-5 py-2.5 text-sm font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-50"
          >
            Ghairi
          </button>
          <button
            type="button"
            disabled={loading || (config.requireReason && !reason.trim())}
            onClick={onConfirm}
            className={`inline-flex items-center gap-2 rounded-xl px-6 py-2.5 text-sm font-bold transition-all disabled:opacity-50 ${
              config.danger
                ? 'bg-gradient-to-r from-red-600 to-red-500 text-white shadow-[0_0_24px_rgba(239,68,68,0.35)] hover:brightness-110'
                : 'bg-gradient-to-r from-[#f5b301] to-amber-400 text-slate-950 shadow-[0_0_24px_rgba(245,179,1,0.35)] hover:brightness-110'
            }`}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {config.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function buildTimeline(report, intelligence) {
  const events = []
  const push = (kind, at, title, detail, tone = 'neutral') => {
    if (!at) return
    events.push({ kind, at, title, detail, tone })
  }

  const accountCreated =
    intelligence?.device?.firstSeenAt ||
    intelligence?.registry?.firstSeenAt ||
    intelligence?.account?.securityProfile?.firstSeenAt
  if (accountCreated) {
    push('login', accountCreated, 'Akaunti iliundwa', intelligence?.device?.deviceId || '', 'success')
  }

  for (const p of report?.payments?.completed || []) {
    push('payment', p.created_at, 'Malipo yamefanikiwa', `${formatTsh(p.amount)} · ${p.plan_name || 'kifurushi'} · ${p.order_id || ''}`, 'success')
  }
  for (const p of report?.payments?.pending || []) {
    push('payment', p.created_at, 'Malipo yanasubiri', `${formatTsh(p.amount)} · ${p.order_id}`, 'warn')
  }
  for (const p of report?.payments?.failed || []) {
    push('payment', p.created_at, 'Malipo yameshindwa', p.last_provider_response || p.order_id, 'danger')
  }
  for (const s of [...(report?.subscriptions?.active || []), ...(report?.subscriptions?.expired || [])]) {
    const txn = String(s.transaction_id || '')
    if (txn.startsWith('recovery:')) {
      push('renew', s.started_at, 'Urejeshaji wa usajili', `Kutoka ${txn.slice('recovery:'.length)}`, 'success')
    } else if (txn.startsWith('offer_code:')) {
      push('manual', s.started_at, 'Msimbo wa ofa umetumika', txn.slice('offer_code:'.length), 'success')
    } else if (txn.startsWith('moved:')) {
      push('transfer', s.started_at, 'Uhamisho (chanzo)', `Kwenda ${txn.slice('moved:'.length)}`, 'warn')
    } else {
      push('renew', s.started_at, 'Usajili umeanza', s.device_id, 'neutral')
    }
    if (s.expires_at) push('renew', s.expires_at, 'Usajili unaisha', statusLabelSw(s.status), 'neutral')
  }
  for (const g of intelligence?.manualGrants || []) {
    const code = g.offer_code || g.code
    const detail = code
      ? `${g.duration_days || '—'} siku · ${code}`
      : `${g.duration_days || '—'} siku`
    push('manual', g.created_at, 'Ongezeko la muda (mkono)', detail, 'success')
  }
  for (const t of intelligence?.packageTransferHistory || []) {
    push('transfer', t.created_at, 'Uhamisho wa kifurushi (toka)', `${t.target_device_id} · ${t.transfer_code || ''}`, 'warn')
  }
  for (const t of intelligence?.receivedTransfers || []) {
    push('migration', t.created_at, 'Uhamisho wa kifurushi (kuingia)', `${t.source_device_id} · ${t.transfer_code || ''}`, 'warn')
  }
  for (const h of intelligence?.deviceHistory || []) {
    push(
      'audit',
      h.recorded_at || h.created_at,
      'Badiliko la kifaa',
      [h.device_model, h.device_brand, h.os_version, h.app_version].filter(Boolean).join(' · ') || h.device_id,
      'neutral',
    )
  }
  for (const ph of intelligence?.paymentHistory || []) {
    const digits = String(ph.phone || '').trim()
    if (digits) {
      push('payment', ph.created_at, 'Simu kwenye muamala', `${digits} · ${ph.order_id || ''}`, 'neutral')
    }
  }
  for (const l of report?.audit_logs || []) {
    const t = String(l.event_type || '').toLowerCase()
    let tone = 'neutral'
    let title = l.event_type || 'Tukio'
    if (t.includes('block')) {
      tone = 'danger'
      title = 'Mtumiaji amezuiwa'
    } else if (t.includes('unblock')) {
      tone = 'success'
      title = 'Zuio limeondolewa'
    } else if (t.includes('repair')) {
      tone = 'success'
      title = 'Ukaguzi / urekebishaji'
    } else if (t.includes('transfer') || t.includes('migration')) {
      tone = 'warn'
      title = 'Uhamisho wa kifurushi'
    } else if (t.includes('verify') || t.includes('subscription')) {
      title = 'Uthibitishaji wa usajili'
    } else if (t.includes('playback') || t.includes('premium')) {
      title = 'Uchezaji wa premium'
    }
    push('audit', l.created_at, title, l.detail || l.status, tone)
  }
  for (const l of intelligence?.loginActivity || []) {
    const et = String(l.event_type || '').toLowerCase()
    const isLogout = et.includes('logout')
    push(
      isLogout ? 'logout' : 'login',
      l.created_at,
      isLogout ? 'Kutoka kwenye programu' : 'Kuingia kwenye programu',
      [l.device_model, l.ip_address, l.country].filter(Boolean).join(' · '),
      'neutral',
    )
  }
  for (const a of intelligence?.adminActions || []) {
    push('admin', a.created_at, `Hatua ya msimamizi: ${a.action}`, a.reason || a.admin_email, 'warn')
  }

  return events
    .filter((e) => e.at)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
}

const TIMELINE_ICON = {
  payment: CreditCard,
  renew: Sparkles,
  manual: Zap,
  transfer: RefreshCw,
  migration: RefreshCw,
  login: User,
  logout: User,
  audit: ShieldCheck,
  admin: ShieldCheck,
}

const TIMELINE_DOT = {
  success: 'bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.6)]',
  danger: 'bg-red-400 shadow-[0_0_12px_rgba(248,113,113,0.6)]',
  warn: 'bg-amber-400 shadow-[0_0_12px_rgba(251,191,36,0.5)]',
  neutral: 'bg-slate-400 shadow-[0_0_8px_rgba(148,163,184,0.4)]',
}

export default function UserProfileDrawer({ row, onClose, onEditSubscription }) {
  const { showToast } = useToast()
  const [activeTab, setActiveTab] = useState('muhtasari')
  const [loading, setLoading] = useState(true)
  const [report, setReport] = useState(null)
  const [intelligence, setIntelligence] = useState(null)
  const [registryId, setRegistryId] = useState(null)
  const [actionBusy, setActionBusy] = useState(null)
  const [confirmAction, setConfirmAction] = useState(null)
  const [confirmReason, setConfirmReason] = useState('')
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
      showToast('error', e?.message || 'Imeshindwa kupakia wasifu')
    } finally {
      setLoading(false)
    }
  }, [deviceId, row?.phone_number, row?.order_id, searchParams, showToast])

  useEffect(() => {
    if (!row) return
    setActiveTab('muhtasari')
    requestAnimationFrame(() => setVisible(true))
    void load()
  }, [row, load])

  useEffect(() => {
    if (!row) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') handleClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [row, onClose])

  function handleClose() {
    setVisible(false)
    window.setTimeout(() => onClose?.(), 280)
  }

  async function copyDeviceId() {
    try {
      await navigator.clipboard.writeText(deviceId)
      showToast('success', 'Device ID imenakiliwa')
    } catch {
      showToast('error', 'Imeshindwa kunakili')
    }
  }

  const primaryDevice = report?.devices?.find((d) => d.device_id === deviceId) || report?.devices?.[0]
  const primarySub =
    report?.subscriptions?.active?.find((s) => s.device_id === deviceId) ||
    report?.subscriptions?.active?.[0] ||
    report?.subscriptions?.expired?.find((s) => s.device_id === deviceId)
  const reg = intelligence?.registry
  const dev = intelligence?.device
  const acct = intelligence?.account
  const isBlocked = primaryDevice?.access?.blocked_now || reg?.status === 'blocked'
  const isActive = primarySub?.active_now && !isBlocked

  const phone =
    row?.phone_number ||
    primaryDevice?.intelligence?.phone_number ||
    reg?.phoneNumber ||
    acct?.phoneNumber ||
    report?.customer?.phone_normalized ||
    '—'

  const fullName = reg?.userId || acct?.userId || intelligence?.account?.userId || 'Mtumiaji Osmani'

  const latestLogin = intelligence?.loginActivity?.[0]
  const loginToday =
    intelligence?.loginActivity?.filter((l) => {
      const d = new Date(l.created_at)
      const n = new Date()
      return d.toDateString() === n.toDateString()
    }).length ?? 0

  const allPayments = useMemo(() => {
    const rows = [
      ...(report?.payments?.completed || []).map((p) => ({ ...p, _bucket: 'completed' })),
      ...(report?.payments?.pending || []).map((p) => ({ ...p, _bucket: 'pending' })),
      ...(report?.payments?.failed || []).map((p) => ({ ...p, _bucket: 'failed' })),
    ]
    return rows.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
  }, [report])

  const paymentStats = useMemo(() => {
    const ok = allPayments.filter((p) => p._bucket === 'completed')
    const bad = allPayments.filter((p) => p._bucket === 'failed')
    const totalPaid = ok.reduce((s, p) => s + (Number(p.amount) || 0), 0)
    return {
      successful: ok.length,
      failed: bad.length,
      totalPaid,
      totalTx: allPayments.length,
    }
  }, [allPayments])

  const subscriptionHistory = useMemo(() => {
    const completed = report?.payments?.completed || []
    const manualByDate = new Map(
      (intelligence?.manualGrants || []).map((g) => [String(g.created_at || ''), g]),
    )
    const transfers = [
      ...(intelligence?.packageTransferHistory || []).map((t) => ({ ...t, _dir: 'out' })),
      ...(intelligence?.receivedTransfers || []).map((t) => ({ ...t, _dir: 'in' })),
    ]

    const fromReport = [...(report?.subscriptions?.active || []), ...(report?.subscriptions?.expired || [])].map(
      (s, idx) => {
        const pay = completed.find((p) => p.device_id === s.device_id) || completed[0]
        const txn = String(s.transaction_id || '')
        let offerCode = '—'
        if (txn.startsWith('offer_code:')) offerCode = txn.slice('offer_code:'.length)
        const manual = [...manualByDate.values()].find(
          (g) => g.created_at && new Date(g.created_at) >= new Date(s.started_at || 0),
        )
        if (manual?.offer_code || manual?.code) offerCode = manual.offer_code || manual.code
        const mig = transfers.find((t) => t.created_at && new Date(t.created_at) >= new Date(s.started_at || 0))
        const repair = (report?.audit_logs || []).find((l) =>
          String(l.event_type || '').toLowerCase().includes('repair'),
        )
        return {
          _key: `sub-${s.device_id}-${idx}`,
          plan_name: pay?.plan_name || '—',
          started_at: s.started_at,
          expires_at: s.expires_at,
          days: daysBetween(s.started_at, s.expires_at),
          amount: pay?.amount,
          status: s.status,
          payment_method: pay?.provider_label || pay?.provider || '—',
          renew_source: pay?.provider_label || '—',
          manual_grant: manual ? `${manual.duration_days || '—'} siku` : '—',
          migration: mig ? (mig._dir === 'in' ? `Kutoka ${mig.source_device_id || '—'}` : `Kwenda ${mig.target_device_id || '—'}`) : '—',
          repair: repair ? formatAdminDateTime(repair.created_at) : '—',
          offer_code: offerCode,
        }
      },
    )

    return fromReport.sort((a, b) => new Date(b.started_at || 0) - new Date(a.started_at || 0))
  }, [report, intelligence])

  const renewCount = report?.payments?.completed?.length ?? subscriptionHistory.length

  const lastPayment = allPayments.find((p) => p._bucket === 'completed') || allPayments[0]

  const timeline = useMemo(() => buildTimeline(report, intelligence), [report, intelligence])

  async function executeConfirmedAction() {
    if (!confirmAction) return
    const { id } = confirmAction
    setActionBusy(id)
    try {
      if (id === 'block') {
        if (!registryId || !confirmReason.trim()) return
        await postUsersIntelligenceBlock(registryId, { reason: confirmReason.trim() })
        showToast('success', 'Mtumiaji amezuiwa')
      } else if (id === 'unblock') {
        if (!registryId) throw new Error('Hakuna rekodi ya intelligence')
        await postUsersIntelligenceUnblock(registryId, {})
        showToast('success', 'Zuio limeondolewa')
      } else if (id === 'refresh' || id === 'repair' || id === 'sync') {
        await postCustomerInvestigationRefreshSubscription({ device_id: deviceId })
        showToast('success', 'Usajili umesasishwa')
      } else if (id === 'extend' || id === 'reduce') {
        setConfirmAction(null)
        setConfirmReason('')
        onEditSubscription?.(row)
        return
      } else if (id === 'verify') {
        showToast('info', 'Tumia ukaguzi wa malipo kwa agizo la mwisho')
      } else if (id === 'transfer' || id === 'move') {
        showToast('info', 'Tumia Uchunguzi wa Mteja kwa uhamisho wa simu')
      }
      setConfirmAction(null)
      setConfirmReason('')
      await load()
    } catch (e) {
      showToast('error', e?.message || 'Hatua imeshindwa')
    } finally {
      setActionBusy(null)
    }
  }

  const adminActions = [
    {
      id: 'block',
      label: 'Zuia',
      icon: Ban,
      hide: isBlocked,
      danger: true,
      confirm: {
        title: 'Zuia mtumiaji',
        message: 'Mtumiaji hataweza kutumia huduma. Sababu itaandikwa kwenye kumbukumbu ya ukaguzi.',
        confirmLabel: 'Zuia sasa',
        requireReason: true,
        danger: true,
      },
    },
    {
      id: 'unblock',
      label: 'Ruhusu',
      icon: CheckCircle2,
      hide: !isBlocked,
      confirm: {
        title: 'Ruhusu mtumiaji',
        message: 'Zuio litaondolewa na mtumiaji ataweza kutumia huduma tena.',
        confirmLabel: 'Ruhusu',
      },
    },
    {
      id: 'verify',
      label: 'Thibitisha Lazima',
      icon: ShieldCheck,
      confirm: {
        title: 'Thibitisha malipo',
        message: 'Hatua hii itaanzisha ukaguzi wa malipo ya mwisho.',
        confirmLabel: 'Thibitisha',
      },
    },
    {
      id: 'repair',
      label: 'Rekebisha',
      icon: Zap,
      confirm: {
        title: 'Rekebisha usajili',
        message: 'Usajili utasomwa upya kutoka kwenye hifadhidata.',
        confirmLabel: 'Rekebisha',
      },
    },
    {
      id: 'refresh',
      label: 'Sasisha',
      icon: RefreshCw,
      confirm: {
        title: 'Sasisha taarifa',
        message: 'Pakia upya hali ya usajili na wasifu.',
        confirmLabel: 'Sasisha',
      },
    },
    {
      id: 'transfer',
      label: 'Hamisha Kifurushi',
      icon: RefreshCw,
      confirm: {
        title: 'Hamisha kifurushi',
        message: 'Uhamisho unahitaji uthibitisho wa namba ya malipo.',
        confirmLabel: 'Endelea',
      },
    },
    {
      id: 'extend',
      label: 'Ongeza Muda',
      icon: Sparkles,
      confirm: {
        title: 'Ongeza muda wa kifurushi',
        message: 'Fungua kihariri cha usajili kuongeza muda.',
        confirmLabel: 'Endelea',
      },
    },
    {
      id: 'reduce',
      label: 'Punguza Muda',
      icon: Clock,
      confirm: {
        title: 'Punguza muda wa kifurushi',
        message: 'Fungua kihariri cha usajili kupunguza muda.',
        confirmLabel: 'Endelea',
      },
    },
    {
      id: 'move',
      label: 'Hamisha Kifaa',
      icon: Smartphone,
      confirm: {
        title: 'Hamisha kifaa',
        message: 'Hatua hii inahitaji uhamisho rasmi wa kifurushi.',
        confirmLabel: 'Endelea',
      },
    },
    {
      id: 'sync',
      label: 'Linganisha',
      icon: RefreshCw,
      confirm: {
        title: 'Linganisha hali',
        message: 'Sawazisha usajili na hifadhidata ya moja kwa moja.',
        confirmLabel: 'Linganisha',
      },
    },
  ].filter((a) => !a.hide)

  if (!row) return null

  return (
    <>
      <div
        className={`fixed inset-0 z-[120] bg-black/75 backdrop-blur-md transition-opacity duration-300 ${visible ? 'opacity-100' : 'opacity-0'}`}
        onClick={handleClose}
        aria-hidden
      />
      <aside
        className={`fixed inset-y-0 right-0 z-[130] flex w-full flex-col bg-[#0B0F1A] shadow-[-24px_0_80px_rgba(0,0,0,0.55)] transition-transform duration-300 ease-out sm:w-[70%] ${visible ? 'translate-x-0' : 'translate-x-full'}`}
        role="dialog"
        aria-modal="true"
        aria-label="Wasifu wa mtumiaji"
      >
        {/* Premium header */}
        <header className="relative shrink-0 overflow-hidden border-b border-slate-800/80 px-6 py-6 sm:px-8">
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-[#f5b301]/[0.07] via-transparent to-cyan-500/[0.04]" />
          <div className="relative flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex min-w-0 flex-1 items-start gap-5">
              <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-[#f5b301]/25 to-amber-600/10 text-2xl font-black text-amber-100 ring-2 ring-[#f5b301]/30 shadow-[0_0_32px_rgba(245,179,1,0.15)]">
                {initialsFrom(fullName, phone)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-2xl font-bold tracking-tight text-white sm:text-3xl">{fullName}</h2>
                  {isActive ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/20 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-emerald-200 ring-1 ring-emerald-400/45">
                      <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.8)]" />
                      Inatumika
                    </span>
                  ) : isBlocked ? (
                    <span className="inline-flex rounded-full bg-red-500/20 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-red-200 ring-1 ring-red-400/45">
                      Imezuiwa
                    </span>
                  ) : (
                    <span className="inline-flex rounded-full bg-slate-600/30 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-slate-300 ring-1 ring-slate-500/40">
                      Haijatumika
                    </span>
                  )}
                </div>
                <p className="mt-1 text-lg font-medium text-slate-300">{phone}</p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <code className="max-w-full truncate rounded-xl border border-slate-700/60 bg-slate-900/60 px-3 py-1.5 font-mono text-xs text-cyan-200/90">
                    {deviceId || '—'}
                  </code>
                  <button
                    type="button"
                    onClick={() => void copyDeviceId()}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-slate-600/70 bg-slate-800/50 px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:border-[#f5b301]/40 hover:text-amber-200"
                  >
                    <Copy className="h-3.5 w-3.5" />
                    Nakili
                  </button>
                </div>
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-2 lg:flex-col lg:items-end">
              <div className="flex flex-wrap gap-2">
                {!isBlocked ? (
                  <button
                    type="button"
                    disabled={Boolean(actionBusy)}
                    onClick={() =>
                      setConfirmAction({
                        id: 'block',
                        title: 'Zuia mtumiaji',
                        message: 'Mtumiaji hataweza kutumia huduma. Sababu itaandikwa kwenye kumbukumbu ya ukaguzi.',
                        confirmLabel: 'Zuia sasa',
                        requireReason: true,
                        danger: true,
                      })
                    }
                    className="rounded-xl bg-gradient-to-r from-red-600 to-red-500 px-6 py-3 text-sm font-bold text-white shadow-[0_0_28px_rgba(239,68,68,0.35)] transition hover:brightness-110 disabled:opacity-50"
                  >
                    Zuia Mtumiaji
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={Boolean(actionBusy)}
                    onClick={() => setConfirmAction({ id: 'unblock', title: 'Ruhusu mtumiaji', message: 'Zuio litaondolewa.', confirmLabel: 'Ruhusu' })}
                    className="rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-500 px-6 py-3 text-sm font-bold text-white shadow-[0_0_28px_rgba(16,185,129,0.35)] transition hover:brightness-110 disabled:opacity-50"
                  >
                    Ruhusu Mtumiaji
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void load()}
                  disabled={loading}
                  className="rounded-xl border border-slate-600/70 bg-slate-800/40 p-3 text-slate-300 hover:bg-slate-700/50 disabled:opacity-50"
                  aria-label="Sasisha"
                >
                  <RefreshCw className={`h-5 w-5 ${loading ? 'animate-spin' : ''}`} />
                </button>
                <button
                  type="button"
                  onClick={handleClose}
                  className="rounded-xl border border-slate-600/70 bg-slate-800/40 p-3 text-slate-300 hover:bg-slate-700/50"
                  aria-label="Funga"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>
          </div>
        </header>

        {/* Premium tabs */}
        <nav className="shrink-0 border-b border-slate-800/80 bg-[#0a0e16]/80 px-4 sm:px-6">
          <div className="flex gap-1 overflow-x-auto custom-scrollbar py-1">
            {TABS.map((t) => {
              const Icon = t.icon
              const active = activeTab === t.id
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setActiveTab(t.id)}
                  className={`group relative inline-flex shrink-0 items-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold transition-all duration-200 ${
                    active
                      ? 'text-amber-100'
                      : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'
                  }`}
                >
                  <Icon className={`h-4 w-4 transition-transform duration-200 ${active ? 'scale-110 text-[#f5b301]' : 'group-hover:scale-105'}`} />
                  {t.label}
                  {active ? (
                    <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-gradient-to-r from-[#f5b301] to-amber-400 shadow-[0_0_12px_rgba(245,179,1,0.6)]" />
                  ) : null}
                </button>
              )
            })}
          </div>
        </nav>

        {/* Content */}
        <div className="custom-scrollbar flex-1 overflow-y-auto bg-[#080c14] px-4 py-6 sm:px-8">
          {loading && !report ? (
            <div className="flex flex-col items-center justify-center gap-3 py-32 text-slate-400">
              <Loader2 className="h-8 w-8 animate-spin text-[#f5b301]" />
              <p className="text-sm font-medium">Inapakia wasifu…</p>
            </div>
          ) : (
            <div className="mx-auto max-w-6xl pb-20">
              {activeTab === 'muhtasari' ? (
                <div className="flex flex-col gap-6">
                  <div className="grid gap-4 md:grid-cols-2">
                    <article className={CARD}>
                      <div className="mb-4 flex items-center gap-2 text-[#f5b301]">
                        <CreditCard className="h-4 w-4" />
                        <h3 className="text-sm font-bold uppercase tracking-wider">Kifurushi</h3>
                      </div>
                      <div className="grid flex-1 gap-4 sm:grid-cols-2">
                        <Metric large label="Kifurushi" value={subscriptionHistory[0]?.plan_name || '—'} />
                        <Metric label="Malipo ya mwisho" value={formatAdminDateTime(lastPayment?.created_at)} />
                        <Metric label="Muda wa mwisho" value={formatAdminDateTime(primarySub?.expires_at)} />
                        <Metric label="Siku zilizobaki" value={formatAdminRemainingFromExpiry(primarySub?.expires_at, new Date())} />
                        <Metric label="Idadi ya upya" value={renewCount} />
                      </div>
                    </article>

                    <article className={CARD}>
                      <div className="mb-4 flex items-center gap-2 text-cyan-400">
                        <Activity className="h-4 w-4" />
                        <h3 className="text-sm font-bold uppercase tracking-wider">Matumizi ya App</h3>
                      </div>
                      <div className="grid flex-1 gap-4 sm:grid-cols-2">
                        <Metric large label="Jumla ya kufungua" value={intelligence?.loginActivity?.length ?? '—'} />
                        <Metric label="Dakika zilizotazamwa" value={intelligence?.usage?.watchTime || '—'} />
                        <Metric label="Leo kufungua" value={loginToday} />
                        <Metric label="Shughuli ya mwisho" value={formatAdminDateTime(dev?.lastSeenAt || latestLogin?.created_at)} />
                      </div>
                    </article>

                    <article className={CARD}>
                      <div className="mb-4 flex items-center gap-2 text-emerald-400">
                        <User className="h-4 w-4" />
                        <h3 className="text-sm font-bold uppercase tracking-wider">Kuingia Mwisho</h3>
                      </div>
                      <div className="grid flex-1 gap-4 sm:grid-cols-2">
                        <Metric label="Tarehe" value={splitDateTime(latestLogin?.created_at).date} />
                        <Metric label="Saa" value={splitDateTime(latestLogin?.created_at).time} />
                        <Metric label="Toleo la Android" value={dev?.osVersion || latestLogin?.os_version || '—'} />
                        <Metric label="Simu / modeli" value={[dev?.deviceBrand, dev?.deviceModel].filter(Boolean).join(' ') || latestLogin?.device_model || '—'} />
                        <Metric label="Jiji" value={latestLogin?.city || latestLogin?.region || '—'} />
                        <Metric label="Nchi" value={latestLogin?.country || '—'} />
                        <Metric label="IP" value={latestLogin?.ip_address || '—'} />
                      </div>
                    </article>

                    <article className={CARD}>
                      <div className="mb-4 flex items-center gap-2 text-amber-400">
                        <CreditCard className="h-4 w-4" />
                        <h3 className="text-sm font-bold uppercase tracking-wider">Muhtasari wa Malipo</h3>
                      </div>
                      <div className="grid flex-1 gap-4 sm:grid-cols-2">
                        <Metric large label="Malipo yaliyofanikiwa" value={paymentStats.successful} />
                        <Metric label="Malipo yaliyoshindwa" value={paymentStats.failed} />
                        <Metric label="Jumla iliyolipwa" value={formatTsh(paymentStats.totalPaid)} />
                        <Metric label="Jumla ya miamala" value={paymentStats.totalTx} />
                      </div>
                    </article>
                  </div>

                  <section>
                    <h3 className="mb-4 text-sm font-bold uppercase tracking-wider text-slate-400">Hatua za Msimamizi</h3>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                      {adminActions.map((a) => {
                        const Icon = a.icon
                        return (
                          <button
                            key={a.id}
                            type="button"
                            disabled={Boolean(actionBusy)}
                            onClick={() => setConfirmAction({ id: a.id, ...a.confirm })}
                            className={`flex items-center gap-3 rounded-2xl border px-4 py-4 text-left text-sm font-semibold transition-all hover:-translate-y-0.5 disabled:opacity-50 ${
                              a.danger
                                ? 'border-red-500/30 bg-red-950/25 text-red-100 hover:shadow-[0_0_20px_rgba(239,68,68,0.2)]'
                                : 'border-slate-700/50 bg-slate-900/40 text-slate-200 hover:border-[#f5b301]/30 hover:shadow-[0_0_20px_rgba(245,179,1,0.12)]'
                            }`}
                          >
                            <Icon className="h-5 w-5 shrink-0 opacity-80" />
                            {a.label}
                          </button>
                        )
                      })}
                    </div>
                  </section>
                </div>
              ) : null}

              {activeTab === 'usajili' ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-lg font-bold text-white">Historia ya Usajili</h3>
                    <span className="text-xs text-slate-500">{subscriptionHistory.length} rekodi</span>
                  </div>
                  <PremiumTable
                    empty="Hakuna historia ya usajili."
                    columns={[
                      { key: 'plan_name', label: 'Kifurushi' },
                      { key: 'started_at', label: 'Mwanzo', render: (r) => formatAdminDateTime(r.started_at) },
                      { key: 'expires_at', label: 'Mwisho', render: (r) => formatAdminDateTime(r.expires_at) },
                      { key: 'days', label: 'Siku' },
                      { key: 'amount', label: 'Kiasi', render: (r) => (r.amount != null ? formatTsh(r.amount) : '—') },
                      { key: 'status', label: 'Hali', render: (r) => <StatusBadge status={r.status} /> },
                      { key: 'payment_method', label: 'Njia ya Malipo' },
                      { key: 'renew_source', label: 'Chanzo cha Upya' },
                      { key: 'manual_grant', label: 'Muda wa Mkono' },
                      { key: 'migration', label: 'Uhamisho' },
                      { key: 'repair', label: 'Urekebishaji' },
                      { key: 'offer_code', label: 'Msimbo wa Ofa' },
                    ]}
                    rows={subscriptionHistory}
                  />
                </div>
              ) : null}

              {activeTab === 'malipo' ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-lg font-bold text-white">Historia ya Malipo</h3>
                    <span className="text-xs text-slate-500">{allPayments.length} miamala</span>
                  </div>
                  <PremiumTable
                    empty="Hakuna malipo."
                    columns={[
                      {
                        key: 'date',
                        label: 'Tarehe',
                        render: (r) => splitDateTime(r.created_at).date,
                      },
                      { key: 'time', label: 'Saa', render: (r) => splitDateTime(r.created_at).time },
                      { key: 'month', label: 'Mwezi', render: (r) => splitDateTime(r.created_at).month },
                      { key: 'year', label: 'Mwaka', render: (r) => splitDateTime(r.created_at).year },
                      { key: 'provider_reference', label: 'Rejea' },
                      { key: 'provider_label', label: 'Lango / Gateway' },
                      { key: 'provider', label: 'Mtoa Huduma' },
                      { key: 'phone', label: 'Simu' },
                      { key: 'amount', label: 'Kiasi', render: (r) => formatTsh(r.amount) },
                      { key: 'status', label: 'Hali', render: (r) => <StatusBadge status={r.status} /> },
                      {
                        key: 'failure',
                        label: 'Sababu ya Kushindwa',
                        render: (r) => r.last_provider_response || '—',
                      },
                      {
                        key: 'receipt',
                        label: 'Risiti',
                        render: (r) => (r._bucket === 'completed' ? r.order_id?.slice(0, 12) : '—'),
                      },
                      { key: 'order_id', label: 'Kitambulisho cha Muamala' },
                    ]}
                    rows={allPayments}
                  />
                </div>
              ) : null}

              {activeTab === 'matumizi' ? (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {[
                    { label: 'Vituo vilivyotazamwa', value: intelligence?.usage?.channelsWatched ?? '—', icon: Activity },
                    { label: 'Dakika zilizotazamwa', value: intelligence?.usage?.watchTime ?? '—', icon: Clock },
                    { label: 'Vikao', value: intelligence?.loginActivity?.length ?? '—', icon: User },
                    { label: 'Kituo cha mwisho', value: intelligence?.usage?.lastChannel ?? '—', icon: Sparkles },
                    { label: 'Aina inayotazamwa zaidi', value: intelligence?.usage?.topCategory ?? '—', icon: LayoutGrid },
                    { label: 'Funguo za premium', value: intelligence?.usage?.premiumUnlocks ?? '—', icon: Zap },
                    { label: 'Hitilafu za uchezaji', value: intelligence?.usage?.playbackFailures ?? '—', icon: Ban },
                    { label: 'Toleo la App', value: dev?.appVersion ?? '—', icon: Smartphone },
                    { label: 'Runtime', value: intelligence?.usage?.runtime ?? dev?.appVersion ?? '—', icon: Activity },
                    { label: 'Toleo la OTA', value: intelligence?.usage?.otaVersion ?? '—', icon: RefreshCw },
                  ].map(({ label, value, icon: Icon }) => (
                    <article key={label} className={CARD}>
                      <div className="mb-3 flex items-center gap-2 text-[#f5b301]/90">
                        <Icon className="h-4 w-4" />
                        <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">{label}</h4>
                      </div>
                      <p className="text-2xl font-bold text-white">{value}</p>
                    </article>
                  ))}
                </div>
              ) : null}

              {activeTab === 'vifaa' ? (
                <div className="space-y-4">
                  {(report?.devices || []).map((d) => {
                    const isCurrent = d.device_id === deviceId
                    return (
                      <article
                        key={d.device_id}
                        className={`rounded-2xl border p-6 shadow-[0_12px_40px_rgba(0,0,0,0.25)] ${
                          isCurrent
                            ? 'border-emerald-500/35 bg-gradient-to-br from-emerald-950/30 to-[#0b1220]/90 ring-1 ring-emerald-400/25'
                            : 'border-slate-700/45 bg-[#0b1220]/80'
                        }`}
                      >
                        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                          <code className="font-mono text-sm text-cyan-200">{d.device_id}</code>
                          {isCurrent ? (
                            <span className="rounded-full bg-emerald-500/20 px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-emerald-200 ring-1 ring-emerald-400/45">
                              Kifaa cha Sasa
                            </span>
                          ) : (
                            <span className="rounded-full bg-slate-700/40 px-3 py-1 text-[10px] font-bold uppercase text-slate-400">
                              Kifaa cha Zamani
                            </span>
                          )}
                        </div>
                        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                          <Metric label="Lengo la uhamisho" value={intelligence?.packageTransferHistory?.[0]?.target_device_id || '—'} />
                          <Metric label="Chanzo cha uhamisho" value={intelligence?.receivedTransfers?.[0]?.source_device_id || '—'} />
                          <Metric label="Install instance" value={d.install_instances?.map((x) => x.install_instance_id).join(', ') || '—'} />
                          <Metric label="Android ID" value={isCurrent ? dev?.androidId : '—'} />
                          <Metric label="Stable Hardware ID" value={isCurrent ? dev?.deviceFingerprint : '—'} />
                          <Metric label="Modeli ya simu" value={isCurrent ? [dev?.deviceBrand, dev?.deviceModel].filter(Boolean).join(' ') : '—'} />
                          <Metric label="Mtengenezaji" value={dev?.deviceBrand || '—'} />
                          <Metric label="Toleo la Android" value={dev?.osVersion || '—'} />
                          <Metric label="Lugha" value={latestLogin?.language || '—'} />
                          <Metric label="Ukanda wa saa" value={latestLogin?.timezone || '—'} />
                          <Metric label="Nchi" value={latestLogin?.country || '—'} />
                        </div>
                      </article>
                    )
                  })}
                  {!report?.devices?.length ? (
                    <p className="py-12 text-center text-slate-500">Hakuna vifaa vilivyosajiliwa.</p>
                  ) : null}
                </div>
              ) : null}

              {activeTab === 'historia' ? (
                <div className="space-y-2">
                  <h3 className="mb-6 text-lg font-bold text-white">Mstari wa Matukio</h3>
                  {timeline.length === 0 ? (
                    <p className="py-12 text-center text-slate-500">Hakuna matukio bado.</p>
                  ) : (
                    <ol className="relative space-y-0 border-l border-slate-700/60 pl-8">
                      {timeline.map((ev, i) => {
                        const Icon = TIMELINE_ICON[ev.kind] || Clock
                        return (
                          <li key={`${ev.at}-${ev.kind}-${i}`} className="relative pb-8">
                            <span
                              className={`absolute -left-[29px] flex h-8 w-8 items-center justify-center rounded-full ring-4 ring-[#080c14] ${TIMELINE_DOT[ev.tone] || TIMELINE_DOT.neutral}`}
                            >
                              <Icon className="h-3.5 w-3.5 text-slate-950/80" />
                            </span>
                            <div className="rounded-2xl border border-slate-700/40 bg-[#0b1220]/80 px-5 py-4 shadow-[0_8px_24px_rgba(0,0,0,0.2)]">
                              <time className="text-xs font-medium text-slate-500">{formatAdminDateTime(ev.at)}</time>
                              <p className="mt-1 text-base font-bold text-white">{ev.title}</p>
                              {ev.detail ? <p className="mt-1 text-sm text-slate-400">{ev.detail}</p> : null}
                            </div>
                          </li>
                        )
                      })}
                    </ol>
                  )}
                </div>
              ) : null}
            </div>
          )}
        </div>
      </aside>

      <ActionConfirmDialog
        open={Boolean(confirmAction)}
        config={confirmAction}
        loading={Boolean(actionBusy)}
        reason={confirmReason}
        onReason={setConfirmReason}
        onConfirm={() => void executeConfirmedAction()}
        onCancel={() => {
          setConfirmAction(null)
          setConfirmReason('')
        }}
      />
    </>
  )
}
