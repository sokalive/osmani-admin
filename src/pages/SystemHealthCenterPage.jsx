import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  BellRing,
  CheckCircle2,
  Database,
  Download,
  FileClock,
  Loader2,
  Lock,
  Play,
  RefreshCw,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wrench,
} from 'lucide-react'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import {
  getSystemHealthAlerts,
  getSystemHealthAudits,
  getSystemHealthMaintenance,
  getSystemHealthReport,
  getSystemHealthSnapshot,
  postSystemHealthAckAlert,
  postSystemHealthAction,
  postSystemHealthMode,
  putSystemHealthSettings,
} from '../lib/api'
import { readAdminSnapshot, writeAdminSnapshot } from '../lib/adminSnapshotCache'

const COLOR_STYLES = {
  green: {
    ring: 'border-emerald-500/30 bg-emerald-950/30 ring-emerald-500/20',
    text: 'text-emerald-300',
    dot: 'bg-emerald-400',
    badge: 'bg-emerald-500/20 text-emerald-200 ring-emerald-400/45',
  },
  yellow: {
    ring: 'border-amber-500/30 bg-amber-950/25 ring-amber-500/20',
    text: 'text-amber-300',
    dot: 'bg-amber-400',
    badge: 'bg-amber-500/20 text-amber-200 ring-amber-400/45',
  },
  red: {
    ring: 'border-red-500/30 bg-red-950/30 ring-red-500/20',
    text: 'text-red-300',
    dot: 'bg-red-400',
    badge: 'bg-red-500/20 text-red-200 ring-red-400/45',
  },
}

function colorFor(color) {
  return COLOR_STYLES[color] || COLOR_STYLES.green
}

function StatusDot({ color }) {
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${colorFor(color).dot}`} />
}

function HealthCard({ title, value, subtitle, color = 'green', icon: Icon }) {
  const c = colorFor(color)
  return (
    <div className={`rounded-2xl border p-4 ring-1 ${c.ring}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{title}</p>
        {Icon ? <Icon className={`h-4 w-4 ${c.text}`} /> : <StatusDot color={color} />}
      </div>
      <p className={`mt-2 truncate text-2xl font-bold ${c.text}`}>{value}</p>
      {subtitle ? <p className="mt-1 text-xs text-slate-400">{subtitle}</p> : null}
    </div>
  )
}

function fmtTime(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('sw-TZ', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Africa/Dar_es_Salaam',
    })
  } catch {
    return new Date(iso).toLocaleString()
  }
}

const MANUAL_BUTTONS = [
  { action: 'run-audit', label: '▶ Endesha Ukaguzi Sasa', icon: Play, confirmSw: 'Endesha ukaguzi kamili wa mfumo sasa? (Ni salama — hausomi wala kubadilisha vifurushi.)' },
  { action: 'clear-cache', label: '▶ Safisha Cache', icon: Trash2, confirmSw: 'Safisha cache zote za muda? (Salama — database ndiyo chanzo cha ukweli.)' },
  { action: 'check-database', label: '▶ Kagua Database', icon: Database, confirmSw: 'Kagua uthabiti wa database? (Usomaji tu.)' },
  { action: 'check-canonical', label: '▶ Kagua Canonical Engine', icon: ShieldCheck, confirmSw: 'Kagua Canonical Engine? (Usomaji tu.)' },
  { action: 'check-guard', label: '▶ Kagua Entitlement Guard', icon: ShieldCheck, confirmSw: 'Kagua Entitlement Guard? (Usomaji tu.)' },
  { action: 'check-legacy-lock', label: '▶ Kagua Legacy Lock', icon: Lock, confirmSw: 'Kagua kufuli za Legacy na Migration? (Usomaji tu.)' },
  { action: 'check-regression', label: '▶ Kagua Regression', icon: Activity, confirmSw: 'Endesha majaribio ya regression? (Yanachukua sekunde chache.)' },
]

const SETTINGS_LABELS = [
  { key: 'alerts_enabled', label: 'Tuma tahadhari kwa matatizo makubwa' },
  { key: 'daily_audits_enabled', label: 'Endesha ukaguzi mara 3 kwa siku (06:00, 14:00, 22:00 EAT)' },
  { key: 'keep_audit_logs', label: 'Weka kumbukumbu za ukaguzi' },
  { key: 'keep_maintenance_history', label: 'Hifadhi historia ya matengenezo' },
  { key: 'notify_after_audit', label: 'Tuma taarifa baada ya ukaguzi kukamilika' },
]

const RANGE_LABELS = [
  { id: 'today', label: 'Leo' },
  { id: 'yesterday', label: 'Jana' },
  { id: 'week', label: 'Wiki Hii' },
  { id: 'month', label: 'Mwezi Huu' },
]

function SystemHealthCenterPage() {
  const { showToast } = useToast()
  const cached = readAdminSnapshot('system-health')
  const [tab, setTab] = useState('dashboard')
  const [snapshot, setSnapshot] = useState(cached?.snapshot ?? null)
  const [alerts, setAlerts] = useState(Array.isArray(cached?.alerts) ? cached.alerts : [])
  const [audits, setAudits] = useState([])
  const [maintenance, setMaintenance] = useState([])
  const [range, setRange] = useState('week')
  const [refreshing, setRefreshing] = useState(false)
  const [busyAction, setBusyAction] = useState(null)
  const [confirming, setConfirming] = useState(null)
  const [actionResult, setActionResult] = useState(null)

  const load = useCallback(async () => {
    try {
      const [snap, al] = await Promise.all([
        getSystemHealthSnapshot().catch(() => null),
        getSystemHealthAlerts().catch(() => null),
      ])
      if (snap?.ok) setSnapshot(snap)
      if (al?.ok) setAlerts(al.alerts || [])
      if (snap?.ok) {
        writeAdminSnapshot('system-health', {
          snapshot: snap,
          alerts: al?.ok ? al.alerts || [] : [],
        })
      }
    } catch (e) {
      showToast('error', e?.message || 'Imeshindikana kupakia hali ya mfumo')
    }
  }, [showToast])

  const loadAudits = useCallback(async (r) => {
    try {
      const res = await getSystemHealthAudits(r)
      if (res?.ok) setAudits(res.audits || [])
      const m = await getSystemHealthMaintenance().catch(() => null)
      if (m?.ok) setMaintenance(m.maintenance || [])
    } catch {
      /* toast on main load only */
    }
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 30_000)
    return () => clearInterval(t)
  }, [load])

  useEffect(() => {
    loadAudits(range)
  }, [loadAudits, range])

  const runRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await Promise.all([load(), loadAudits(range)])
    } finally {
      setRefreshing(false)
    }
  }, [load, loadAudits, range])

  const setMode = useCallback(
    async (mode) => {
      const msg =
        mode === 'auto'
          ? 'Washa SAFE AUTO FIX? Mfumo utarekebisha matatizo SALAMA tu (cache, ufuatiliaji). Vifurushi, malipo na expiry HAVITAGUSWA kamwe bila idhini yako.'
          : 'Rudi kwenye hali ya MANUAL? Hakuna marekebisho ya moja kwa moja yatakayofanyika.'
      if (!window.confirm(msg)) return
      try {
        await postSystemHealthMode(mode)
        showToast('success', mode === 'auto' ? 'SAFE AUTO FIX imewashwa' : 'Hali ya MANUAL imewashwa')
        await load()
      } catch (e) {
        showToast('error', e?.message || 'Imeshindikana kubadilisha hali')
      }
    },
    [load, showToast],
  )

  const runAction = useCallback(
    async (btn) => {
      setConfirming(null)
      setBusyAction(btn.action)
      setActionResult(null)
      try {
        const res = await postSystemHealthAction(btn.action)
        setActionResult({ action: btn.action, label: btn.label, res })
        showToast(res?.ok !== false ? 'success' : 'error', res?.message_sw || 'Kitendo kimekamilika')
        await Promise.all([load(), loadAudits(range)])
      } catch (e) {
        showToast('error', e?.message || 'Kitendo kimeshindikana')
      } finally {
        setBusyAction(null)
      }
    },
    [load, loadAudits, range, showToast],
  )

  const ackAlert = useCallback(
    async (id) => {
      if (!window.confirm('Thibitisha kuwa umeiona tahadhari hii?')) return
      try {
        await postSystemHealthAckAlert(id)
        showToast('success', 'Tahadhari imethibitishwa')
        await load()
      } catch (e) {
        showToast('error', e?.message || 'Imeshindikana kuthibitisha')
      }
    },
    [load, showToast],
  )

  const saveSetting = useCallback(
    async (key, value) => {
      try {
        await putSystemHealthSettings({ [key]: value })
        showToast('success', 'Mipangilio imehifadhiwa')
        await load()
      } catch (e) {
        showToast('error', e?.message || 'Imeshindikana kuhifadhi mipangilio')
      }
    },
    [load, showToast],
  )

  const downloadReport = useCallback(async () => {
    try {
      const report = await getSystemHealthReport()
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `ripoti-afya-ya-mfumo-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
      showToast('success', 'Ripoti imepakuliwa')
    } catch (e) {
      showToast('error', e?.message || 'Imeshindikana kupakua ripoti')
    }
  }, [showToast])

  const cards = snapshot?.cards
  const mode = snapshot?.mode || 'manual'
  const overall = snapshot?.alerts_summary
  const overallColor = overall?.overall_color || 'green'

  const tabs = useMemo(
    () => [
      { id: 'dashboard', label: 'Dashibodi', icon: Activity },
      { id: 'alerts', label: 'Tahadhari', icon: BellRing, badge: overall?.open || 0 },
      { id: 'history', label: 'Historia ya Ukaguzi', icon: FileClock },
      { id: 'settings', label: 'Mipangilio', icon: Settings },
    ],
    [overall],
  )

  return (
    <>
      <Topbar />
      <main className="mt-6 flex min-h-0 flex-1 flex-col gap-6">
        <header className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white sm:text-3xl">🛡️ Kituo cha Afya ya Mfumo</h1>
            <p className="mt-1 text-sm text-slate-400">
              Ufuatiliaji na matengenezo ya production — kila kitu kinalindwa na Entitlement Guard,
              Canonical Validator na kufuli za Legacy/Migration.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className={`flex items-center gap-2 rounded-xl border px-3 py-2 ring-1 ${colorFor(overallColor).ring}`}>
              <StatusDot color={overallColor} />
              <span className={`text-sm font-semibold ${colorFor(overallColor).text}`}>
                {overall?.overall_message_sw || 'Inapakia…'}
              </span>
            </div>
            <button
              type="button"
              onClick={runRefresh}
              disabled={refreshing}
              className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-amber-400 to-yellow-500 px-4 py-2.5 text-sm font-bold text-slate-950 shadow-[0_8px_28px_rgba(251,191,36,0.35)] disabled:opacity-50"
            >
              {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Onyesha Upya
            </button>
          </div>
        </header>

        {/* AUTO / MANUAL mode */}
        <section className="rounded-2xl border border-slate-700/60 bg-slate-900/50 p-4 ring-1 ring-white/[0.04]">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-bold text-white">Hali ya Uendeshaji</p>
              <p className="mt-0.5 text-xs text-slate-400">
                {mode === 'auto'
                  ? 'SAFE AUTO FIX imewashwa — mfumo unarekebisha matatizo SALAMA tu (cache na ufuatiliaji). Vifurushi, malipo na expiry vinahitaji idhini ya msimamizi kila wakati.'
                  : 'Hali ya MANUAL — hakuna marekebisho ya moja kwa moja. Msimamizi anaamua kila hatua.'}
              </p>
            </div>
            <div className="flex overflow-hidden rounded-xl border border-slate-700/70">
              <button
                type="button"
                onClick={() => mode !== 'auto' && setMode('auto')}
                className={`px-4 py-2 text-sm font-bold transition ${
                  mode === 'auto'
                    ? 'bg-emerald-500/90 text-slate-950'
                    : 'bg-slate-900/60 text-slate-300 hover:bg-slate-800'
                }`}
              >
                <span className="inline-flex items-center gap-1.5">
                  <Sparkles className="h-4 w-4" /> AUTO — Safe Auto Fix
                </span>
              </button>
              <button
                type="button"
                onClick={() => mode !== 'manual' && setMode('manual')}
                className={`px-4 py-2 text-sm font-bold transition ${
                  mode === 'manual'
                    ? 'bg-amber-400 text-slate-950'
                    : 'bg-slate-900/60 text-slate-300 hover:bg-slate-800'
                }`}
              >
                <span className="inline-flex items-center gap-1.5">
                  <Wrench className="h-4 w-4" /> MANUAL
                </span>
              </button>
            </div>
          </div>
        </section>

        {/* Tabs */}
        <nav className="flex flex-wrap gap-2">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition ${
                tab === t.id
                  ? 'bg-gradient-to-r from-amber-300 to-yellow-500 text-slate-950'
                  : 'bg-slate-900/60 text-slate-300 ring-1 ring-slate-700/60 hover:bg-slate-800'
              }`}
            >
              <t.icon className="h-4 w-4" />
              {t.label}
              {t.badge ? (
                <span className="rounded-full bg-red-500/90 px-2 py-0.5 text-[10px] font-bold text-white">
                  {t.badge}
                </span>
              ) : null}
            </button>
          ))}
        </nav>

        {tab === 'dashboard' && (
          <>
            {/* Daily checks */}
            <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {(snapshot?.daily_checks || []).map((c) => (
                <div key={c.slot} className={`rounded-2xl border p-4 ring-1 ${colorFor(c.color).ring}`}>
                  <div className="flex items-center gap-2">
                    <StatusDot color={c.color} />
                    <p className="text-sm font-bold text-white">{c.title}</p>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <p className="uppercase text-slate-500">Hali</p>
                      <p className={`mt-0.5 text-lg font-bold ${colorFor(c.color).text}`}>{c.status}</p>
                      <p className="text-[11px] text-slate-400">{c.status_sw}</p>
                    </div>
                    <div>
                      <p className="uppercase text-slate-500">Muda</p>
                      <p className="mt-0.5 text-lg font-bold text-white">{c.scheduled_time}</p>
                      <p className="text-[11px] text-slate-400">
                        Mwisho: {c.last_run_at ? fmtTime(c.last_run_at) : 'Bado haujafanyika'}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </section>

            {/* Health cards */}
            <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
              <HealthCard
                title="Historical Over-credit"
                value={cards ? cards.historical_over_credit : '…'}
                subtitle={cards?.historical_over_credit === 0 ? 'Hakuna mkopo wa ziada' : 'Inahitaji uhakiki'}
                color={cards?.historical_over_credit === 0 ? 'green' : 'red'}
              />
              <HealthCard
                title="Legacy Cache"
                value={cards ? cards.legacy_cache : '…'}
                subtitle={cards?.legacy_cache === 0 ? 'Cache za zamani zimezimwa' : 'ONYO'}
                color={cards?.legacy_cache === 0 ? 'green' : 'red'}
              />
              <HealthCard
                title="Invalid Expiry"
                value={cards ? cards.invalid_expiry : '…'}
                subtitle={cards?.invalid_expiry === 0 ? 'Hakuna expiry batili' : 'Inahitaji uhakiki'}
                color={cards?.invalid_expiry === 0 ? 'green' : 'red'}
              />
              <HealthCard
                title="Canonical Validator"
                value={cards?.canonical_validator || '…'}
                subtitle={cards?.canonical_validator_sw}
                color={cards?.canonical_validator === 'Healthy' ? 'green' : 'yellow'}
                icon={ShieldCheck}
              />
              <HealthCard
                title="Entitlement Guard"
                value={cards?.entitlement_guard || '…'}
                subtitle={`${cards?.guard_rejections_24h ?? 0} kukataliwa (saa 24) — ulinzi ukifanya kazi`}
                color="green"
                icon={ShieldCheck}
              />
              <HealthCard
                title="Cache Source of Truth"
                value={cards?.cache_source_of_truth || '…'}
                subtitle="Cache ni kwa kasi tu — database ndiyo ukweli"
                color="green"
                icon={Database}
              />
              <HealthCard
                title="Regression Tests"
                value={cards?.regression || '…'}
                subtitle={cards?.regression_pass ? 'Majaribio yote yamefaulu' : 'Kuna jaribio lililoshindwa'}
                color={cards?.regression_pass ? 'green' : 'red'}
                icon={CheckCircle2}
              />
              <HealthCard
                title="System Health"
                value={cards ? `${cards.system_health_pct}%` : '…'}
                subtitle={
                  cards?.system_health_pct === 100
                    ? 'SALAMA — mfumo mzima uko sawa'
                    : 'Kagua tahadhari kwa maelezo'
                }
                color={
                  cards == null
                    ? 'yellow'
                    : cards.system_health_pct === 100
                      ? 'green'
                      : cards.system_health_pct >= 80
                        ? 'yellow'
                        : 'red'
                }
                icon={Activity}
              />
            </section>

            {/* Manual action buttons */}
            <section className="rounded-2xl border border-slate-700/60 bg-slate-900/50 p-4 ring-1 ring-white/[0.04]">
              <p className="text-sm font-bold text-white">Vitendo vya Mkono</p>
              <p className="mt-0.5 text-xs text-slate-400">
                Kila kitendo kinahitaji uthibitisho. Hakuna kitendo kinachoweza kubadilisha vifurushi,
                malipo au expiry — ukaguzi ni usomaji tu.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {MANUAL_BUTTONS.map((btn) => (
                  <button
                    key={btn.action}
                    type="button"
                    disabled={busyAction != null}
                    onClick={() => setConfirming(btn)}
                    className="inline-flex items-center gap-2 rounded-xl bg-slate-800/80 px-4 py-2.5 text-sm font-semibold text-slate-200 ring-1 ring-slate-600/60 transition hover:bg-slate-700 disabled:opacity-50"
                  >
                    {busyAction === btn.action ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <btn.icon className="h-4 w-4" />
                    )}
                    {btn.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={downloadReport}
                  className="inline-flex items-center gap-2 rounded-xl bg-slate-800/80 px-4 py-2.5 text-sm font-semibold text-slate-200 ring-1 ring-slate-600/60 transition hover:bg-slate-700"
                >
                  <Download className="h-4 w-4" />
                  ▶ Pakua Ripoti
                </button>
              </div>
              {actionResult ? (
                <div className="mt-3 rounded-xl border border-slate-700/60 bg-slate-950/60 p-3 text-xs text-slate-300">
                  <p className="font-bold text-white">{actionResult.label}</p>
                  <p className="mt-1">{actionResult.res?.message_sw || 'Kimekamilika.'}</p>
                  {actionResult.res?.report ? (
                    <p className="mt-1 text-slate-400">
                      Matokeo: {actionResult.res.report.anomaly_count ?? 0} yaliyoonekana ·{' '}
                      {actionResult.res.report.critical_count ?? 0} makubwa ·{' '}
                      {actionResult.res.report.high_count ?? 0} ya juu
                    </p>
                  ) : null}
                </div>
              ) : null}
            </section>
          </>
        )}

        {tab === 'alerts' && (
          <section className="flex flex-col gap-3">
            {alerts.length === 0 ? (
              <div className={`rounded-2xl border p-6 text-center ring-1 ${colorFor('green').ring}`}>
                <p className="text-lg font-bold text-emerald-300">🟢 Mfumo uko salama.</p>
                <p className="mt-1 text-sm text-slate-400">Hakuna tahadhari zilizopo kwa sasa.</p>
              </div>
            ) : (
              alerts.map((a) => (
                <div key={a.id} className={`rounded-2xl border p-4 ring-1 ${colorFor(a.color).ring}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <StatusDot color={a.color} />
                      <span className={`text-sm font-bold ${colorFor(a.color).text}`}>{a.severity_sw}</span>
                      <span
                        className={`rounded-lg px-2 py-0.5 text-[10px] font-bold uppercase ring-1 ${colorFor(a.color).badge}`}
                      >
                        {a.status}
                      </span>
                    </div>
                    <span className="text-xs text-slate-400">{fmtTime(a.time)}</span>
                  </div>
                  <p className="mt-2 text-sm text-slate-200">{a.reason_sw}</p>
                  <p className="mt-1 text-xs text-slate-400">Hatua inayoshauriwa: {a.recommended_action_sw}</p>
                  {a.affected_devices?.length ? (
                    <p className="mt-1 truncate text-xs text-slate-500">
                      Vifaa vilivyoathirika ({a.affected_devices.length}):{' '}
                      {a.affected_devices.slice(0, 5).join(', ')}
                      {a.affected_devices.length > 5 ? '…' : ''}
                    </p>
                  ) : null}
                  <p className="mt-1 text-[11px] text-slate-500">Muhtasari wa kiufundi: {a.summary}</p>
                  {a.status === 'INASUBIRI' ? (
                    <button
                      type="button"
                      onClick={() => ackAlert(a.id)}
                      className="mt-3 inline-flex items-center gap-2 rounded-xl bg-slate-800/80 px-3 py-2 text-xs font-semibold text-slate-200 ring-1 ring-slate-600/60 hover:bg-slate-700"
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      Thibitisha Umeiona
                    </button>
                  ) : null}
                </div>
              ))
            )}
          </section>
        )}

        {tab === 'history' && (
          <section className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-2">
              {RANGE_LABELS.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setRange(r.id)}
                  className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
                    range === r.id
                      ? 'bg-gradient-to-r from-amber-300 to-yellow-500 text-slate-950'
                      : 'bg-slate-900/60 text-slate-300 ring-1 ring-slate-700/60 hover:bg-slate-800'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>

            <div className="overflow-hidden rounded-2xl border border-slate-700/60 bg-slate-950/40 ring-1 ring-white/[0.04]">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-700/80 bg-slate-900/60 text-[11px] uppercase tracking-wide text-slate-400">
                      <th className="px-4 py-3 font-semibold">Ukaguzi</th>
                      <th className="px-4 py-3 font-semibold">Matokeo</th>
                      <th className="px-4 py-3 font-semibold">Muda</th>
                      <th className="px-4 py-3 font-semibold">Muda wa Kufanya</th>
                      <th className="px-4 py-3 font-semibold">Matatizo Yaliyoonekana</th>
                      <th className="px-4 py-3 font-semibold">Yaliyorekebishwa</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audits.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-4 py-6 text-center text-slate-500">
                          Hakuna kumbukumbu za ukaguzi kwa kipindi hiki.
                        </td>
                      </tr>
                    ) : (
                      audits.map((a) => (
                        <tr key={a.id} className="border-b border-slate-800/80 hover:bg-slate-900/50">
                          <td className="px-4 py-3 font-medium text-slate-200">{a.slot_sw}</td>
                          <td className="px-4 py-3">
                            <span
                              className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-0.5 text-[11px] font-bold uppercase ring-1 ${colorFor(a.color).badge}`}
                            >
                              <StatusDot color={a.color} />
                              {a.result}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-slate-300">{fmtTime(a.time)}</td>
                          <td className="px-4 py-3 tabular-nums text-slate-300">
                            {a.duration_ms != null ? `${(a.duration_ms / 1000).toFixed(1)}s` : '—'}
                          </td>
                          <td className="px-4 py-3 tabular-nums text-slate-300">{a.issues_found}</td>
                          <td className="px-4 py-3 tabular-nums text-slate-300">{a.issues_fixed}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-700/60 bg-slate-900/50 p-4 ring-1 ring-white/[0.04]">
              <p className="text-sm font-bold text-white">Historia ya Matengenezo</p>
              <div className="mt-2 flex flex-col gap-2">
                {maintenance.length === 0 ? (
                  <p className="text-xs text-slate-500">Hakuna matengenezo yaliyorekodiwa bado.</p>
                ) : (
                  maintenance.slice(0, 20).map((m) => (
                    <div
                      key={m.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-950/60 px-3 py-2 text-xs"
                    >
                      <span className="font-semibold text-slate-200">{m.action}</span>
                      <span className="text-slate-400">
                        {m.mode === 'auto' ? 'AUTO (Safe Fix)' : 'MANUAL'} · {m.performed_by}
                      </span>
                      <span className={m.ok ? 'text-emerald-300' : 'text-red-300'}>
                        {m.ok ? 'IMEFAULU' : 'IMESHINDWA'}
                      </span>
                      <span className="text-slate-500">{fmtTime(m.time)}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </section>
        )}

        {tab === 'settings' && snapshot?.settings && (
          <section className="flex max-w-2xl flex-col gap-3">
            <div className="rounded-2xl border border-slate-700/60 bg-slate-900/50 p-4 ring-1 ring-white/[0.04]">
              <p className="text-sm font-bold text-white">Mipangilio ya Kituo cha Afya</p>
              <div className="mt-3 flex flex-col gap-3">
                <label className="flex items-center justify-between gap-3 rounded-xl bg-slate-950/60 px-3 py-3">
                  <span className="text-sm text-slate-200">
                    ✓ Safe Auto Fix {mode === 'auto' ? 'imewashwa' : 'imezimwa'}
                    <span className="block text-xs text-slate-500">
                      Inarekebisha matatizo salama tu (cache na ufuatiliaji)
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    checked={mode === 'auto'}
                    onChange={(e) => setMode(e.target.checked ? 'auto' : 'manual')}
                    className="h-5 w-5 accent-emerald-500"
                  />
                </label>
                {SETTINGS_LABELS.map((s) => (
                  <label
                    key={s.key}
                    className="flex items-center justify-between gap-3 rounded-xl bg-slate-950/60 px-3 py-3"
                  >
                    <span className="text-sm text-slate-200">✓ {s.label}</span>
                    <input
                      type="checkbox"
                      checked={snapshot.settings[s.key] === true}
                      onChange={(e) => saveSetting(s.key, e.target.checked)}
                      className="h-5 w-5 accent-emerald-500"
                    />
                  </label>
                ))}
                <label className="flex items-center justify-between gap-3 rounded-xl bg-slate-950/60 px-3 py-3">
                  <span className="text-sm text-slate-200">
                    ✓ Weka muda wa kuhifadhi ripoti (siku)
                  </span>
                  <input
                    type="number"
                    min={7}
                    max={365}
                    defaultValue={snapshot.settings.report_retention_days}
                    onBlur={(e) => saveSetting('report_retention_days', Number(e.target.value) || 90)}
                    className="w-24 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-right text-sm text-white"
                  />
                </label>
              </div>
            </div>
            <div className={`rounded-2xl border p-4 text-xs ring-1 ${colorFor('yellow').ring}`}>
              <p className="flex items-center gap-2 font-bold text-amber-300">
                <AlertTriangle className="h-4 w-4" /> Usalama wa Production
              </p>
              <p className="mt-1 text-slate-300">
                Kituo hiki hakiwezi kamwe kubadilisha vifurushi, malipo, expiry, DELETE USER, umiliki wa
                kifaa, historia ya malipo, data ya canonical wala migration. Matatizo makubwa
                yanaonyeshwa kama 🔴 TAHADHARI na yanasubiri uthibitisho wa msimamizi.
              </p>
            </div>
          </section>
        )}

        {/* Confirmation modal */}
        {confirming ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
            <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
              <p className="text-lg font-bold text-white">Thibitisha Kitendo</p>
              <p className="mt-2 text-sm text-slate-300">{confirming.confirmSw}</p>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConfirming(null)}
                  className="rounded-xl bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-300 hover:bg-slate-700"
                >
                  Ghairi
                </button>
                <button
                  type="button"
                  onClick={() => runAction(confirming)}
                  className="rounded-xl bg-gradient-to-r from-amber-400 to-yellow-500 px-4 py-2 text-sm font-bold text-slate-950"
                >
                  Ndiyo, Endelea
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </main>
    </>
  )
}

export default SystemHealthCenterPage
