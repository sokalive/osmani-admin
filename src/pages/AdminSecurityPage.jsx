import { useCallback, useEffect, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import {
  deleteAdminTrustedDevice,
  getAdminAuthDevices,
  postAdminDeviceBlock,
  postAdminDeviceForceOtp,
  postAdminDeviceUnblock,
} from '../lib/api'
import { formatAdminDateTime } from '../lib/formatAdminDateTime'

export default function AdminSecurityPage() {
  const { showToast } = useToast()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const out = await getAdminAuthDevices()
      setRows(Array.isArray(out?.devices) ? out.devices : [])
    } catch (e) {
      showToast('error', e?.message || 'Haikuwezekana kupakia vifaa')
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [showToast])

  useEffect(() => {
    void load()
  }, [load])

  async function run(id, fn) {
    setBusyId(id)
    try {
      await fn()
      showToast('success', 'Imefanikiwa')
      await load()
    } catch (e) {
      showToast('error', e?.message || 'Imeshindikana')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
      <Topbar />
      <main className="mt-6 flex min-h-0 flex-1 flex-col gap-6">
        <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-emerald-500/30 bg-emerald-500/10">
              <ShieldCheck className="h-5 w-5 text-emerald-300" aria-hidden />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-400/90">Security</p>
              <h1 className="text-2xl font-bold text-white sm:text-3xl">ADMIN SECURITY</h1>
              <p className="mt-1 text-sm text-slate-400">Vifaa vinavyoaminiwa · vizuiwi · OTP tena</p>
            </div>
          </div>
          <button
            type="button"
            disabled={loading}
            onClick={() => void load()}
            className="rounded-xl border border-slate-600 bg-slate-900/80 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-50"
          >
            Onyesha upya
          </button>
        </header>

        <section className="overflow-x-auto rounded-2xl border border-slate-700/60 bg-slate-950/40 ring-1 ring-white/[0.04]">
          <table className="min-w-[920px] w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-slate-700/60 bg-slate-900/60 text-xs uppercase tracking-wide text-slate-400">
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
                  <td colSpan={7} className="px-3 py-10 text-center text-slate-500">
                    Inapakia…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-10 text-center text-slate-500">
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
                        <span className="text-slate-200">{r.deviceName || '—'}</span>
                        {r.isCurrentDevice ? (
                          <span className="ml-2 rounded-md bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-200 ring-1 ring-amber-500/40">
                            CURRENT
                          </span>
                        ) : null}
                      </td>
                      <td className="max-w-[200px] truncate px-3 py-2.5 text-xs text-slate-400" title={r.browser}>
                        {r.browser || '—'}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs text-slate-400">{r.ipAddress || '—'}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-slate-300">{formatAdminDateTime(r.createdAt)}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-slate-300">{formatAdminDateTime(r.lastUsedAt)}</td>
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
                              disabled={b}
                              onClick={() => void run(r.id, () => postAdminDeviceBlock(r.id))}
                              className="rounded-md bg-rose-600/90 px-2 py-1 text-[11px] font-bold text-white hover:bg-rose-500 disabled:opacity-40"
                            >
                              BLOCK
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={b}
                              onClick={() => void run(r.id, () => postAdminDeviceUnblock(r.id))}
                              className="rounded-md bg-emerald-700/90 px-2 py-1 text-[11px] font-bold text-white hover:bg-emerald-600 disabled:opacity-40"
                            >
                              UNBLOCK
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={b || r.blocked}
                            onClick={() => void run(r.id, () => postAdminDeviceForceOtp(r.id))}
                            className="rounded-md border border-amber-600/60 bg-amber-950/40 px-2 py-1 text-[11px] font-bold text-amber-100 hover:bg-amber-900/40 disabled:opacity-40"
                          >
                            FORCE OTP
                          </button>
                          <button
                            type="button"
                            disabled={b}
                            onClick={() => void run(r.id, () => deleteAdminTrustedDevice(r.id))}
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
      </main>
    </>
  )
}
