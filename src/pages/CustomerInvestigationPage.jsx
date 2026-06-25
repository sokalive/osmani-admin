import { useCallback, useState } from 'react'
import { Loader2, RefreshCw, Search, ShieldCheck, UserSearch } from 'lucide-react'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import {
  customerInvestigationForceActivate,
  customerInvestigationForceTransfer,
  customerInvestigationReconcile,
  customerInvestigationRefreshSubscription,
  investigateCustomer,
} from '../lib/api'
import { formatAdminDateTime } from '../lib/formatAdminDateTime'
import { formatTsh } from '../lib/formatMoney'

function inputClass() {
  return 'w-full rounded-xl border border-slate-600/60 bg-[#0a0e16] px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-cyan-500/50 focus:outline-none focus:ring-2 focus:ring-cyan-500/20'
}

function labelClass() {
  return 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400'
}

function statusLabelSw(st) {
  const s = String(st ?? '').toLowerCase()
  if (s === 'active') return 'Inatumika'
  if (s === 'completed') return 'Yamefanikiwa'
  if (s === 'pending') return 'Yanasubiri'
  if (s === 'failed') return 'Yameshindwa'
  return st || '—'
}

function badge(st) {
  const s = String(st ?? '').toLowerCase()
  if (s === 'active' || s === 'completed') return 'bg-emerald-500/20 text-emerald-200 ring-emerald-400/40'
  if (s === 'pending') return 'bg-amber-500/20 text-amber-200 ring-amber-400/40'
  return 'bg-red-500/20 text-red-200 ring-red-400/40'
}

function PaymentTable({ title, rows }) {
  if (!rows?.length) return null
  return (
    <section className="rounded-2xl border border-slate-700/60 bg-[#0b1220]/80 p-4">
      <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-300">{title}</h3>
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="text-xs uppercase text-slate-500">
            <tr>
              <th className="px-2 py-2">Agizo</th>
              <th className="px-2 py-2">Kifaa</th>
              <th className="px-2 py-2">Simu</th>
              <th className="px-2 py-2">Kifurushi</th>
              <th className="px-2 py-2">Kiasi</th>
              <th className="px-2 py-2">Mtoa huduma</th>
              <th className="px-2 py-2">Hali</th>
              <th className="px-2 py-2">Tarehe</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.order_id} className="border-t border-slate-800/80">
                <td className="max-w-[140px] truncate px-2 py-2 font-mono text-xs text-cyan-200">{r.order_id}</td>
                <td className="max-w-[120px] truncate px-2 py-2 font-mono text-xs">{r.device_id || '—'}</td>
                <td className="px-2 py-2">{r.phone || r.phone_normalized || '—'}</td>
                <td className="px-2 py-2">{r.plan_name || r.plan_id || '—'}</td>
                <td className="px-2 py-2">{r.amount != null ? formatTsh(r.amount) : '—'}</td>
                <td className="px-2 py-2">{r.provider_label}</td>
                <td className="px-2 py-2">
                  <span className={`rounded-lg px-2 py-0.5 text-[10px] font-bold uppercase ring-1 ${badge(r.status)}`}>
                    {statusLabelSw(r.status)}
                  </span>
                </td>
                <td className="px-2 py-2 text-xs text-slate-500">{formatAdminDateTime(r.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function CustomerInvestigationPage() {
  const { showToast } = useToast()
  const [form, setForm] = useState({
    phone: '',
    device_id: '',
    order_id: '',
    external_id: '',
    account_id: '',
    install_instance_id: '',
  })
  const [loading, setLoading] = useState(false)
  const [actionBusy, setActionBusy] = useState('')
  const [report, setReport] = useState(null)

  const runSearch = useCallback(async () => {
    const params = Object.fromEntries(Object.entries(form).filter(([, v]) => String(v).trim()))
    if (!Object.keys(params).length) {
      showToast('error', 'Weka angalau sehemu moja ya utafutaji')
      return
    }
    setLoading(true)
    try {
      const data = await investigateCustomer(params)
      setReport(data)
    } catch (e) {
      showToast('error', e?.message || 'Uchunguzi umeshindwa')
      setReport(null)
    } finally {
      setLoading(false)
    }
  }, [form, showToast])

  async function runAction(action) {
    if (!action) return
    setActionBusy(action.action)
    try {
      if (action.action === 'retry_reconciliation' && action.order_id) {
        await customerInvestigationReconcile({ order_id: action.order_id, confirm: true })
        showToast('success', 'Ulinganisho umekamilika')
      } else if (action.action === 'force_activate' && action.order_id) {
        if (!window.confirm(`Thibitisha kuamsha kifurushi kwa agizo ${action.order_id}?`)) return
        await customerInvestigationForceActivate({ order_id: action.order_id, confirm: true })
        showToast('success', 'Jaribio la kuamsha limefanywa')
      } else if (action.action === 'refresh_subscription' && action.device_id) {
        await customerInvestigationRefreshSubscription({ device_id: action.device_id })
        showToast('success', 'Hali ya kifurushi imesasishwa')
      } else if (action.action === 'force_transfer') {
        const target = window.prompt('Device ID ya kifaa lengwa kwa uhamisho:')
        if (!target?.trim()) return
        if (!window.confirm(`Thibitisha uhamisho kutoka ${action.source_device_id} kwenda ${target}?`)) return
        await customerInvestigationForceTransfer({
          payment_phone: form.phone || report?.query?.phone_normalized,
          target_device_id: target.trim(),
          confirm: true,
        })
        showToast('success', 'Uhamisho umekamilika')
      } else {
        showToast('info', action.label)
        return
      }
      await runSearch()
    } catch (e) {
      showToast('error', e?.message || 'Hatua imeshindwa')
    } finally {
      setActionBusy('')
    }
  }

  return (
    <>
      <Topbar />
      <main className="mt-6 flex flex-col gap-6">
        <header>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-400/90">Msaada</p>
          <h1 className="mt-1 flex items-center gap-2 text-2xl font-bold text-white">
            <UserSearch className="h-7 w-7 text-cyan-400" />
            Uchunguzi wa Mteja
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-400">
            Tafuta kwa namba ya simu, device ID, agizo, au install ID ili kuona vifurushi, malipo, vifaa vilivyounganishwa,
            na hatua zinazopendekezwa. Ni kusoma tu hadi uthibitishe hatua.
          </p>
        </header>

        <section className="rounded-2xl border border-slate-700/60 bg-[#0b1220]/80 p-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[
              ['phone', 'Namba ya Simu'],
              ['device_id', 'Device ID'],
              ['order_id', 'Agizo ID'],
              ['external_id', 'Kumbukumbu ya Malipo'],
              ['account_id', 'Akaunti ID'],
              ['install_instance_id', 'Install instance ID'],
            ].map(([key, label]) => (
              <div key={key}>
                <label className={labelClass()}>{label}</label>
                <input
                  className={inputClass()}
                  value={form[key]}
                  onChange={(e) => setForm((p) => ({ ...p, [key]: e.target.value }))}
                  placeholder={label}
                />
              </div>
            ))}
          </div>
          <button
            type="button"
            disabled={loading}
            onClick={runSearch}
            className="mt-4 inline-flex items-center gap-2 rounded-xl bg-cyan-500/20 px-5 py-2.5 text-sm font-semibold text-cyan-100 ring-1 ring-cyan-500/40 hover:bg-cyan-500/30 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Chunguza
          </button>
        </section>

        {report ? (
          <div className="flex flex-col gap-4">
            <section className="rounded-2xl border border-cyan-500/20 bg-cyan-500/5 p-4">
              <h2 className="text-sm font-bold text-cyan-100">Uchunguzi (kusoma tu)</h2>
              <p className="mt-1 text-sm text-slate-200">{report.diagnosis?.summary}</p>
              {report.diagnosis?.not_activated_reasons?.length > 1 ? (
                <ul className="mt-2 list-disc pl-5 text-xs text-slate-400">
                  {report.diagnosis.not_activated_reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              ) : null}
              {report.customer?.payment_phone_owner_device_id ? (
                <p className="mt-2 text-xs text-slate-400">
                  Kifaa cha namba ya malipo:{' '}
                  <span className="font-mono text-cyan-200">{report.customer.payment_phone_owner_device_id}</span>
                </p>
              ) : null}
            </section>

            {report.suggested_actions?.length ? (
              <section className="rounded-2xl border border-slate-700/60 bg-[#0b1220]/80 p-4">
                <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-300">Hatua Inayopendekezwa</h3>
                <div className="flex flex-col gap-2">
                  {report.suggested_actions.map((a, i) => (
                    <div
                      key={`${a.action}-${i}`}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-700/50 bg-slate-900/40 px-3 py-2"
                    >
                      <div>
                        <p className="text-sm font-medium text-white">{a.label}</p>
                        <p className="text-xs text-slate-500">{a.reason}</p>
                      </div>
                      {['retry_reconciliation', 'force_activate', 'refresh_subscription', 'force_transfer'].includes(
                        a.action,
                      ) ? (
                        <button
                          type="button"
                          disabled={Boolean(actionBusy)}
                          onClick={() => runAction(a)}
                          className="rounded-lg bg-amber-500/15 px-3 py-1.5 text-xs font-semibold text-amber-200 ring-1 ring-amber-500/30 hover:bg-amber-500/25 disabled:opacity-50"
                        >
                          {actionBusy === a.action ? (
                            <Loader2 className="inline h-3 w-3 animate-spin" />
                          ) : (
                            'Tekeleza'
                          )}
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            <section className="rounded-2xl border border-slate-700/60 bg-[#0b1220]/80 p-4">
              <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-300">
                Vifaa ({report.devices?.length ?? 0})
              </h3>
              <div className="space-y-3">
                {report.devices?.map((d) => (
                  <div key={d.device_id} className="rounded-xl border border-slate-700/50 bg-slate-900/30 p-3">
                    <p className="font-mono text-xs text-cyan-200">{d.device_id}</p>
                    {d.install_instances?.length ? (
                      <p className="mt-1 text-xs text-slate-500">
                        install_instance: {d.install_instances.map((x) => x.install_instance_id).filter(Boolean).join(', ') || '—'}
                      </p>
                    ) : null}
                    {d.access ? (
                      <p className="mt-1 text-xs text-slate-400">
                        Ufikiaji: {d.access.active_now ? 'inatumika' : 'haitumiki'}
                        {d.access.blocked_now ? ' (imezuiwa)' : ''}
                        {d.access.expires_at ? ` · inaisha ${formatAdminDateTime(d.access.expires_at)}` : ''}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>

            <PaymentTable title="Malipo — Yamefanikiwa" rows={report.payments?.completed} />
            <PaymentTable title="Malipo — Yanasubiri" rows={report.payments?.pending} />
            <PaymentTable title="Malipo — Yameshindwa" rows={report.payments?.failed} />

            {report.audit_logs?.length ? (
              <section className="rounded-2xl border border-slate-700/60 bg-[#0b1220]/80 p-4">
                <h3 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-slate-300">
                  <ShieldCheck className="h-4 w-4" /> Kumbukumbu za ukaguzi
                </h3>
                <ul className="max-h-64 space-y-2 overflow-y-auto text-xs text-slate-400">
                  {report.audit_logs.map((l) => (
                    <li key={l.id} className="rounded-lg bg-slate-900/40 px-2 py-1.5">
                      <span className="text-slate-500">{formatAdminDateTime(l.created_at)}</span> · {l.event_type}{' '}
                      <span className={l.status === 'completed' ? 'text-emerald-400' : 'text-amber-400'}>
                        ({statusLabelSw(l.status)})
                      </span>
                      {l.detail ? ` — ${l.detail}` : ''}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <button
              type="button"
              onClick={runSearch}
              className="inline-flex items-center gap-2 self-start text-xs text-slate-500 hover:text-cyan-300"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Sasisha ripoti
            </button>
          </div>
        ) : null}
      </main>
    </>
  )
}

export default CustomerInvestigationPage
