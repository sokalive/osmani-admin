import { useCallback, useEffect, useState } from 'react'
import { ArrowUpCircle, Search } from 'lucide-react'
import { getAppVersionMigrationStats } from '../lib/api'

function statBox(label, value) {
  return (
    <div className="rounded-xl border border-slate-700/60 bg-[#0a0e16] px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-white">{Number(value || 0).toLocaleString()}</p>
    </div>
  )
}

function statusLabel(status) {
  if (status === 'updated_to_v24') return 'Updated to v24'
  if (status === 'legacy_not_updated') return 'Legacy (not updated)'
  if (status === 'brand_new_v24') return 'New v24 install'
  return status || '—'
}

export default function AppVersionMigrationCard() {
  const [summary, setSummary] = useState(null)
  const [items, setItems] = useState([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async (q = '') => {
    setLoading(true)
    setError('')
    try {
      const data = await getAppVersionMigrationStats({ search: q, limit: 20 })
      setSummary(data?.summary ?? null)
      setItems(Array.isArray(data?.items) ? data.items : [])
    } catch (e) {
      setError(e?.message || 'Could not load migration stats')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load('')
  }, [load])

  const byVersion = summary?.byLegacyVersion ?? {}

  return (
    <section className="rounded-2xl border border-slate-700/50 bg-[#0b0f17] p-5 shadow-[0_12px_40px_rgba(0,0,0,0.35)] ring-1 ring-white/[0.04] sm:p-6">
      <div className="mb-4 flex items-start gap-3">
        <ArrowUpCircle className="mt-0.5 h-6 w-6 shrink-0 text-[#f5b301]" aria-hidden />
        <div>
          <h2 className="text-lg font-bold text-white">Legacy → v24 Migration</h2>
          <p className="mt-1 text-sm text-slate-500">
            Users who were on v16–v23 and moved to v24 (Render + VPS combined). Brand-new v24 installs are
            excluded from &quot;updated&quot; counts.
          </p>
        </div>
      </div>

      {error ? <p className="mb-4 text-sm text-red-400">{error}</p> : null}

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {statBox('Still on legacy', summary?.legacyNotUpdated)}
        {statBox('Updated to v24', summary?.updatedToV24)}
        {statBox('Legacy population', summary?.totalLegacyPopulation)}
        {statBox('New v24 installs', summary?.brandNewV24)}
      </div>

      <div className="mb-5 flex flex-wrap gap-2">
        {[16, 17, 18, 19, 20, 21, 22, 23].map((v) => (
          <span
            key={v}
            className="rounded-lg border border-slate-700/70 bg-[#0a0e16] px-2.5 py-1 text-xs font-medium text-slate-300"
          >
            v{v}: {Number(byVersion[`v${v}`] || 0)}
          </span>
        ))}
      </div>

      <form
        className="mb-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void load(search.trim())
        }}
      >
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search device_id or phone"
            className="w-full rounded-xl border border-slate-600/60 bg-[#0a0e16] py-2.5 pl-9 pr-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-[#f5b301]/50 focus:outline-none"
          />
        </div>
        <button
          type="submit"
          className="shrink-0 rounded-xl border border-slate-600/60 bg-slate-800/80 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700/80"
        >
          Search
        </button>
      </form>

      {loading ? (
        <p className="text-sm text-slate-500">Loading migration data…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-slate-500">No matching devices.</p>
      ) : (
        <ul className="max-h-56 space-y-2 overflow-y-auto pr-1 text-sm">
          {items.map((row) => (
            <li
              key={row.deviceId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800/80 bg-[#0a0e16] px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate font-mono text-xs text-slate-300">{row.deviceId}</p>
                {row.phoneNumber ? (
                  <p className="text-xs text-slate-500">{row.phoneNumber}</p>
                ) : null}
              </div>
              <div className="text-right text-xs">
                <p className="font-semibold text-slate-200">{statusLabel(row.status)}</p>
                {row.maxLegacyVersion ? (
                  <p className="text-slate-500">was v{row.maxLegacyVersion}</p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
