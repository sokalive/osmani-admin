import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, ChevronDown, ChevronRight, Loader2, Shield } from 'lucide-react'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import { getSecurityDeviceInvestigation } from '../lib/api'
import { formatReadableDateTime } from '../lib/formatTxDisplay'
import { levelBadgeClass } from '../lib/securityLevels'

function Section({ title, children, className = '' }) {
  return (
    <section
      className={`rounded-2xl border border-slate-700/60 bg-slate-900/40 p-5 lg:p-6 ${className}`}
    >
      <h2 className="mb-4 text-sm font-bold uppercase tracking-wide text-cyan-400/90">{title}</h2>
      {children}
    </section>
  )
}

function InfoGrid({ rows }) {
  return (
    <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs font-semibold uppercase text-slate-500">{label}</dt>
          <dd className="mt-1 break-all text-sm text-slate-100">{value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  )
}

function LevelPill({ level }) {
  return (
    <span
      className={`inline-flex rounded-lg px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ring-1 ${levelBadgeClass(level)}`}
    >
      {level || 'warning'}
    </span>
  )
}

function formatEnforcementAction(action) {
  const map = {
    block_playback: 'Playback blocked',
    auto_block: 'Automatic block (strict)',
    elevated_risk: 'Elevated risk',
    whitelisted: 'Whitelisted',
    allowed: 'Allowed by admin',
    temporary_block: 'Temporary admin block',
    permanent_block: 'Permanent admin block',
    monitor: 'Monitoring',
  }
  return map[action] || action?.replace(/_/g, ' ') || '—'
}

function formatBlockState(state) {
  const map = {
    blocked: 'Blocked',
    whitelisted: 'Whitelisted',
    not_blocked: 'Not blocked',
  }
  return map[state] || state || '—'
}

function CollapsibleRaw({ title, data }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-xl border border-slate-700/50 bg-slate-950/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm font-medium text-slate-200 hover:bg-slate-800/40"
      >
        <span>{title}</span>
        {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
      </button>
      {open ? (
        <pre className="max-h-80 overflow-auto border-t border-slate-800/80 p-4 font-mono text-[11px] leading-relaxed text-slate-400">
          {JSON.stringify(data, null, 2)}
        </pre>
      ) : null}
    </div>
  )
}

export default function SecurityRiskDeviceInvestigationPage() {
  const { deviceId } = useParams()
  const navigate = useNavigate()
  const { showToast } = useToast()
  const [loading, setLoading] = useState(true)
  const [report, setReport] = useState(null)

  const load = useCallback(async () => {
    if (!deviceId) return
    setLoading(true)
    try {
      const res = await getSecurityDeviceInvestigation(deviceId)
      setReport(res?.report ?? res)
    } catch (e) {
      showToast('error', e?.message || 'Failed to load investigation')
      setReport(null)
    } finally {
      setLoading(false)
    }
  }, [deviceId, showToast])

  useEffect(() => {
    void load()
  }, [load])

  const info = report?.device_information
  const summary = report?.detection_summary
  const reasons = report?.detection_reasons ?? []
  const swahili = report?.swahili_explanations ?? []
  const timeline = report?.security_timeline ?? []
  const raw = report?.raw_evidence

  return (
    <>
      <Topbar />
      <main className="mt-6 flex min-h-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 -mx-1 mb-6 flex flex-wrap items-center gap-4 border-b border-slate-800/80 bg-[#060a12]/95 px-1 py-4 backdrop-blur-md">
          <button
            type="button"
            onClick={() => navigate('/security?tab=risk')}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2 text-sm text-slate-200 hover:border-cyan-500/40"
          >
            <ArrowLeft className="h-4 w-4" />
            Risk Devices
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-cyan-400">
              <Shield className="h-5 w-5 shrink-0" />
              <span className="text-xs font-bold uppercase tracking-widest">Security Investigation</span>
            </div>
            <h1 className="mt-1 truncate font-mono text-lg font-bold text-white sm:text-xl">
              {deviceId || '—'}
            </h1>
            <p className="text-xs text-slate-500">Read-only · evidence loaded on demand</p>
          </div>
          {summary?.risk_level ? <LevelPill level={summary.risk_level} /> : null}
        </header>

        {loading ? (
          <div className="flex flex-1 items-center justify-center py-24 text-slate-400">
            <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
          </div>
        ) : !report ? (
          <p className="py-16 text-center text-slate-500">Investigation report not found.</p>
        ) : (
          <div className="mx-auto w-full max-w-6xl flex-1 space-y-6 overflow-y-auto pb-16">
            <Section title="A. Device Information">
              <InfoGrid
                rows={[
                  ['Device ID', info?.device_id],
                  ['Phone number', info?.phone_number || '—'],
                  ['App version', info?.app_version || '—'],
                  ['First seen', formatReadableDateTime(info?.first_seen)],
                  ['Last seen', formatReadableDateTime(info?.last_seen)],
                  ['Current status', info?.current_status],
                  ['Risk score', String(info?.risk_score ?? 0)],
                ]}
              />
            </Section>

            <Section title="B. Detection Summary">
              <InfoGrid
                rows={[
                  ['Risk level', summary?.risk_level || '—'],
                  ['Final enforcement action', formatEnforcementAction(summary?.final_enforcement_action)],
                  ['Detection timestamp', formatReadableDateTime(summary?.detection_timestamp)],
                  ['Current block state', formatBlockState(summary?.current_block_state)],
                  [
                    'Playback',
                    summary?.playback_denied ? 'Denied (security)' : 'Not denied by security policy',
                  ],
                  ['Strict enforcement', summary?.strict_enforcement ? 'On' : 'Off (monitor only)'],
                ]}
              />
            </Section>

            <Section title="C. Detection Reasons">
              {reasons.length ? (
                <ul className="space-y-3">
                  {reasons.map((r) => (
                    <li
                      key={r.key}
                      className="rounded-xl border border-slate-700/50 bg-slate-950/50 px-4 py-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium text-white">{r.label}</span>
                        <span className="text-xs text-slate-500">
                          {r.risk_score != null ? `Score +${r.risk_score}` : ''}
                          {r.source ? ` · ${r.source}` : ''}
                        </span>
                      </div>
                      {r.detail ? <p className="mt-2 text-xs text-slate-400">{r.detail}</p> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-slate-500">No detection reasons recorded for this device.</p>
              )}
            </Section>

            <Section title="D. Human Explanation (Swahili)">
              {swahili.length ? (
                <div className="space-y-4">
                  {swahili.map((s) => (
                    <blockquote
                      key={s.key}
                      className="rounded-xl border-l-4 border-cyan-500/50 bg-slate-950/50 px-4 py-3 text-sm leading-relaxed text-slate-200"
                    >
                      <p className="mb-1 text-xs font-semibold uppercase text-cyan-300/80">{s.label}</p>
                      {s.text}
                    </blockquote>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-slate-500">Hakuna maelezo ya Kiswahili — hakuna ishara zilizogunduliwa.</p>
              )}
            </Section>

            <Section title="E. Security Timeline">
              {timeline.length ? (
                <ol className="relative space-y-0 border-l border-slate-700/60 pl-6">
                  {timeline.map((ev) => (
                    <li key={ev.id} className="relative pb-6 last:pb-0">
                      <span className="absolute -left-[1.65rem] top-1.5 h-2.5 w-2.5 rounded-full bg-cyan-500 ring-4 ring-[#060a12]" />
                      <p className="text-sm font-medium text-white">{ev.title}</p>
                      <p className="mt-0.5 text-xs text-slate-500">{formatReadableDateTime(ev.at)}</p>
                      {ev.detail ? (
                        <p className="mt-1 text-xs text-slate-400">{ev.detail}</p>
                      ) : null}
                      <p className="mt-1 text-[10px] uppercase tracking-wide text-slate-600">
                        {ev.kind?.replace(/_/g, ' ')}
                        {ev.actor ? ` · ${ev.actor}` : ''}
                      </p>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-slate-500">No timeline events yet.</p>
              )}
            </Section>

            <Section title="F. Raw Evidence">
              <div className="space-y-2">
                <CollapsibleRaw title="Detection flags" data={raw?.detection_flags} />
                <CollapsibleRaw title="Internal signals" data={raw?.internal_signals} />
                <CollapsibleRaw title="Security payload (metadata)" data={raw?.security_payload} />
                <CollapsibleRaw title="Integrity results" data={raw?.integrity_results} />
                <CollapsibleRaw title="Signature checks" data={raw?.signature_checks} />
                <CollapsibleRaw title="Playback policy snapshot" data={raw?.playback_policy} />
              </div>
            </Section>

            {report.generated_at ? (
              <p className="text-center text-[10px] text-slate-600">
                Report generated {formatReadableDateTime(report.generated_at)}
              </p>
            ) : null}
          </div>
        )}
      </main>
    </>
  )
}
