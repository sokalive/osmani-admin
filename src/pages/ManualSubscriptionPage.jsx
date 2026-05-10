import { useCallback, useEffect, useState } from 'react'
import { Gift, History, Ticket } from 'lucide-react'
import FlashMessage from '../components/FlashMessage'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import {
  deleteManualSubscriptionGrant,
  deleteOfferCode,
  getManualSubscriptionHistory,
  getOfferCodesHistory,
  postManualSubscriptionBlock,
  postManualSubscriptionGrant,
  postManualSubscriptionUnblock,
  postOfferCodeBlock,
  postOfferCodeGenerate,
  postOfferCodeUnblock,
} from '../lib/api'
import { formatAdminDateTime } from '../lib/formatAdminDateTime'

const DURATIONS = [
  { days: 1, label: 'Siku 1' },
  { days: 7, label: 'Siku 7' },
  { days: 30, label: 'Siku 30' },
  { days: 90, label: 'Siku 90' },
]

function inputClass() {
  return 'w-full rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-500/60 focus:outline-none focus:ring-2 focus:ring-amber-500/25'
}

function selectClass() {
  return inputClass()
}

function tabBtn(active) {
  return `rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
    active
      ? 'bg-amber-500/20 text-amber-200 ring-1 ring-amber-500/40'
      : 'bg-slate-900/50 text-slate-400 hover:bg-slate-800/80 hover:text-slate-200'
  }`
}

function ManualSubscriptionPage() {
  const { showToast } = useToast()
  const [tab, setTab] = useState('grant')
  const [deviceId, setDeviceId] = useState('')
  const [durationDays, setDurationDays] = useState(7)
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState(null)

  const [historyRows, setHistoryRows] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyBusyId, setHistoryBusyId] = useState(null)

  const [offerDurationDays, setOfferDurationDays] = useState(7)
  const [offerPin, setOfferPin] = useState('')
  const [generatedOfferCode, setGeneratedOfferCode] = useState('')
  const [offerBusy, setOfferBusy] = useState(false)
  const [offerRows, setOfferRows] = useState([])
  const [offerLoading, setOfferLoading] = useState(false)
  const [offerBusyCode, setOfferBusyCode] = useState(null)

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      const out = await getManualSubscriptionHistory()
      const rows = Array.isArray(out?.rows) ? out.rows : []
      setHistoryRows(rows)
    } catch (err) {
      showToast('error', err?.message || 'Historia haikuweza kupakiwa')
    } finally {
      setHistoryLoading(false)
    }
  }, [showToast])

  const loadOfferHistory = useCallback(async () => {
    setOfferLoading(true)
    try {
      const out = await getOfferCodesHistory()
      const rows = Array.isArray(out?.rows) ? out.rows : []
      setOfferRows(rows)
    } catch (err) {
      showToast('error', err?.message || 'Historie ya codes haikuweza kupakiwa')
    } finally {
      setOfferLoading(false)
    }
  }, [showToast])

  useEffect(() => {
    if (tab === 'history') void loadHistory()
  }, [tab, loadHistory])

  useEffect(() => {
    if (tab === 'offer') void loadOfferHistory()
  }, [tab, loadOfferHistory])

  async function handleOfferGenerate(e) {
    e?.preventDefault?.()
    if (!offerPin.trim()) {
      showToast('error', 'Ingiza PIN')
      return
    }
    setOfferBusy(true)
    try {
      const out = await postOfferCodeGenerate({
        durationDays: offerDurationDays,
        pin: offerPin.trim(),
      })
      setGeneratedOfferCode(String(out.code ?? ''))
      showToast('success', 'Code imetengenezwa')
      void loadOfferHistory()
    } catch (err) {
      showToast('error', err?.message || 'Imeshindikana')
    } finally {
      setOfferBusy(false)
    }
  }

  async function regenerateOfferAfterCopy() {
    if (!offerPin.trim()) {
      showToast('error', 'Ingiza PIN kutengeneza code mpya')
      setGeneratedOfferCode('')
      return
    }
    setOfferBusy(true)
    try {
      const out = await postOfferCodeGenerate({
        durationDays: offerDurationDays,
        pin: offerPin.trim(),
      })
      setGeneratedOfferCode(String(out.code ?? ''))
      void loadOfferHistory()
    } catch (err) {
      showToast('error', err?.message || 'Code mpya haikutengenezwa')
      setGeneratedOfferCode('')
    } finally {
      setOfferBusy(false)
    }
  }

  async function handleCopyOfferCode() {
    if (!generatedOfferCode) return
    try {
      await navigator.clipboard.writeText(generatedOfferCode)
      showToast('success', 'Imenakiliwa')
      await regenerateOfferAfterCopy()
    } catch {
      showToast('error', 'Unakili umeshindwa')
    }
  }

  async function handleOfferBlock(code) {
    setOfferBusyCode(`b:${code}`)
    try {
      await postOfferCodeBlock(code)
      showToast('success', 'Code imezuiwa')
      await loadOfferHistory()
    } catch (err) {
      showToast('error', err?.message || 'Imeshindikana')
    } finally {
      setOfferBusyCode(null)
    }
  }

  async function handleOfferUnblock(code) {
    setOfferBusyCode(`u:${code}`)
    try {
      await postOfferCodeUnblock(code)
      showToast('success', 'Code imefunguliwa')
      await loadOfferHistory()
    } catch (err) {
      showToast('error', err?.message || 'Imeshindikana')
    } finally {
      setOfferBusyCode(null)
    }
  }

  async function handleOfferDelete(code) {
    if (!window.confirm(`Futa code ${code}?`)) return
    setOfferBusyCode(`d:${code}`)
    try {
      await deleteOfferCode(code)
      showToast('success', 'Code imefutwa')
      await loadOfferHistory()
    } catch (err) {
      showToast('error', err?.message || 'Imeshindikana')
    } finally {
      setOfferBusyCode(null)
    }
  }

  function offerStatusStyle(status) {
    const s = String(status ?? '').toUpperCase()
    if (s === 'UNUSED') return 'bg-emerald-500/15 text-emerald-200 ring-emerald-500/30'
    if (s === 'USED') return 'bg-slate-600/40 text-slate-200 ring-slate-500/25'
    if (s === 'BLOCKED') return 'bg-rose-500/15 text-rose-200 ring-rose-500/30'
    if (s === 'EXPIRED') return 'bg-amber-500/15 text-amber-200 ring-amber-500/30'
    if (s === 'DELETED') return 'bg-slate-800/80 text-slate-500 ring-slate-600/40'
    return 'bg-slate-600/40 text-slate-300 ring-slate-500/25'
  }

  async function handleSubmit(e) {
    e.preventDefault()
    const d = deviceId.trim()
    if (!d) {
      showToast('error', 'Ingiza Device ID')
      return
    }
    if (!pin.trim()) {
      showToast('error', 'Ingiza PIN kabla ya kuweka kifurushi')
      return
    }
    setBusy(true)
    try {
      const out = await postManualSubscriptionGrant({
        deviceId: d,
        durationDays,
        pin: pin.trim(),
      })
      setFlash({
        type: 'success',
        message: `Kifurushi kimewekwa. Muda wa mwisho: ${formatAdminDateTime(out.expiresAt, { fallback: '—' })} (grant #${out.grantId ?? '—'})`,
      })
      void loadHistory()
    } catch (err) {
      showToast('error', err?.message || 'Imeshindikana')
    } finally {
      setBusy(false)
    }
  }

  async function handleBlock(device_id) {
    setHistoryBusyId(`b:${device_id}`)
    try {
      await postManualSubscriptionBlock(device_id)
      showToast('success', 'Kifurushi kimezuiwa')
      await loadHistory()
    } catch (err) {
      showToast('error', err?.message || 'Imeshindikana')
    } finally {
      setHistoryBusyId(null)
    }
  }

  async function handleUnblock(device_id) {
    setHistoryBusyId(`u:${device_id}`)
    try {
      await postManualSubscriptionUnblock(device_id)
      showToast('success', 'Kifurushi kimeruhusiwa tena')
      await loadHistory()
    } catch (err) {
      showToast('error', err?.message || 'Imeshindikana')
    } finally {
      setHistoryBusyId(null)
    }
  }

  async function handleDeleteGrant(grantId) {
    if (!window.confirm('Futa rekodi hii kwenye historia? (Huduma ya kifurushi kwenye kifaa hubaki.)')) return
    setHistoryBusyId(`d:${grantId}`)
    try {
      await deleteManualSubscriptionGrant(grantId)
      showToast('success', 'Rekodi imefutwa')
      await loadHistory()
    } catch (err) {
      showToast('error', err?.message || 'Imeshindikana')
    } finally {
      setHistoryBusyId(null)
    }
  }

  function statusLabel(row) {
    if (row.effectiveBlocked) return { text: 'Zimezuiwa', className: 'bg-rose-500/15 text-rose-200 ring-rose-500/30' }
    if (row.subscriptionActive) return { text: 'Hai', className: 'bg-emerald-500/15 text-emerald-200 ring-emerald-500/30' }
    return { text: 'Siyo hai', className: 'bg-slate-600/40 text-slate-300 ring-slate-500/25' }
  }

  return (
    <>
      <Topbar />
      <main className="mt-6 flex min-h-0 flex-1 flex-col gap-6">
        {flash ? (
          <FlashMessage type={flash.type} message={flash.message} onDismiss={() => setFlash(null)} />
        ) : null}

        <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/10">
              <Gift className="h-5 w-5 text-amber-300" aria-hidden />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-400/90">Admin</p>
              <h1 className="text-2xl font-bold text-white sm:text-3xl">Toa Kifurushi</h1>
              <p className="mt-1 text-sm text-slate-400">Manual subscription · Device ID + muda</p>
            </div>
          </div>
        </header>

        <div className="flex flex-wrap gap-2">
          <button type="button" className={tabBtn(tab === 'grant')} onClick={() => setTab('grant')}>
            Toa Kifurushi
          </button>
          <button
            type="button"
            className={tabBtn(tab === 'history')}
            onClick={() => setTab('history')}
          >
            <span className="inline-flex items-center gap-2">
              <History className="h-4 w-4 opacity-90" aria-hidden />
              HISTORY
            </span>
          </button>
          <button type="button" className={tabBtn(tab === 'offer')} onClick={() => setTab('offer')}>
            <span className="inline-flex items-center gap-2">
              <Ticket className="h-4 w-4 opacity-90" aria-hidden />
              OFFER CODES
            </span>
          </button>
        </div>

        {tab === 'grant' ? (
          <section className="max-w-xl space-y-5 rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6 ring-1 ring-white/[0.04]">
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="ms-device" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Device ID
                </label>
                <input
                  id="ms-device"
                  className={inputClass()}
                  value={deviceId}
                  onChange={(e) => setDeviceId(e.target.value)}
                  placeholder="000865b4f965515c"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              <div>
                <label htmlFor="ms-duration" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Muda wa kifurushi
                </label>
                <select
                  id="ms-duration"
                  className={selectClass()}
                  value={durationDays}
                  onChange={(e) => setDurationDays(Number(e.target.value))}
                >
                  {DURATIONS.map((o) => (
                    <option key={o.days} value={o.days}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="ms-pin" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">
                  PIN ya uhakiki
                </label>
                <input
                  id="ms-pin"
                  type="password"
                  className={inputClass()}
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  placeholder="Ingiza PIN"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </div>

              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-xl bg-gradient-to-r from-amber-400 to-yellow-500 py-3 text-sm font-bold text-slate-950 shadow-[0_8px_28px_rgba(251,191,36,0.35)] transition-transform hover:scale-[1.01] disabled:opacity-60 sm:w-auto sm:min-w-[200px] sm:px-8"
              >
                {busy ? 'Inaweka…' : 'Weka Kifurushi'}
              </button>
            </form>
          </section>
        ) : tab === 'history' ? (
          <section className="min-w-0 space-y-4 rounded-2xl border border-slate-700/60 bg-slate-950/40 p-4 ring-1 ring-white/[0.04] sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-slate-400">Historia ya mikopo ya mikono (manual grants).</p>
              <button
                type="button"
                disabled={historyLoading}
                onClick={() => void loadHistory()}
                className="rounded-lg border border-slate-600 bg-slate-900/80 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-50"
              >
                {historyLoading ? 'Inapakia…' : 'Onyesha upya'}
              </button>
            </div>

            <div className="overflow-x-auto rounded-xl border border-slate-700/50">
              <table className="min-w-[880px] w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-700/60 bg-slate-900/60 text-xs uppercase tracking-wide text-slate-400">
                    <th className="px-3 py-3 font-semibold">Device ID</th>
                    <th className="px-3 py-3 font-semibold">Muda</th>
                    <th className="px-3 py-3 font-semibold">Alipotolewa</th>
                    <th className="px-3 py-3 font-semibold">Mwisho</th>
                    <th className="px-3 py-3 font-semibold">Hali</th>
                    <th className="px-3 py-3 font-semibold">Vitendo</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80">
                  {historyLoading && historyRows.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-slate-500">
                        Inapakia…
                      </td>
                    </tr>
                  ) : historyRows.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-slate-500">
                        Hakuna rekodi bado.
                      </td>
                    </tr>
                  ) : (
                    historyRows.map((row) => {
                      const st = statusLabel(row)
                      const shortDev =
                        row.deviceId.length > 22 ? `${row.deviceId.slice(0, 20)}…` : row.deviceId
                      const blockBusy = historyBusyId === `b:${row.deviceId}`
                      const unblockBusy = historyBusyId === `u:${row.deviceId}`
                      const delBusy = historyBusyId === `d:${row.id}`
                      return (
                        <tr key={row.id} className="bg-slate-950/20 hover:bg-slate-900/40">
                          <td className="max-w-[200px] truncate px-3 py-2.5 font-mono text-xs text-slate-200" title={row.deviceId}>
                            {shortDev}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-slate-300">{row.durationDays} siku</td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-slate-300">{formatAdminDateTime(row.grantedAt)}</td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-slate-300">{formatAdminDateTime(row.expiresAt)}</td>
                          <td className="px-3 py-2.5">
                            <span
                              className={`inline-flex rounded-lg px-2 py-0.5 text-xs font-semibold ring-1 ${st.className}`}
                            >
                              {st.text}
                            </span>
                            {row.adminDeviceBlocked && !row.manualAdminBlocked ? (
                              <span className="mt-1 block text-[10px] text-slate-500">Kifaa pia kwenye admin block</span>
                            ) : null}
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="flex flex-wrap gap-1.5">
                              <button
                                type="button"
                                disabled={row.manualAdminBlocked || blockBusy || delBusy}
                                onClick={() => void handleBlock(row.deviceId)}
                                className="rounded-md bg-rose-600/90 px-2 py-1 text-xs font-semibold text-white hover:bg-rose-500 disabled:opacity-40"
                              >
                                {blockBusy ? '…' : 'BLOCK'}
                              </button>
                              <button
                                type="button"
                                disabled={!row.manualAdminBlocked || unblockBusy || delBusy}
                                onClick={() => void handleUnblock(row.deviceId)}
                                className="rounded-md bg-emerald-700/90 px-2 py-1 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-40"
                              >
                                {unblockBusy ? '…' : 'UNBLOCK'}
                              </button>
                              <button
                                type="button"
                                disabled={delBusy || blockBusy || unblockBusy}
                                onClick={() => void handleDeleteGrant(row.id)}
                                className="rounded-md border border-slate-600 bg-slate-800/80 px-2 py-1 text-xs font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-40"
                              >
                                {delBusy ? '…' : 'DELETE'}
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>
        ) : (
          <div className="flex flex-col gap-8">
            <section className="max-w-xl space-y-5 rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6 ring-1 ring-white/[0.04]">
              <h2 className="text-lg font-semibold text-white">Tengeneza code</h2>
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  void handleOfferGenerate(e)
                }}
                className="space-y-4"
              >
                <div>
                  <label
                    htmlFor="oc-duration"
                    className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400"
                  >
                    Muda wa kifurushi
                  </label>
                  <select
                    id="oc-duration"
                    className={selectClass()}
                    value={offerDurationDays}
                    onChange={(e) => setOfferDurationDays(Number(e.target.value))}
                  >
                    {DURATIONS.map((o) => (
                      <option key={o.days} value={o.days}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label
                    htmlFor="oc-pin"
                    className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400"
                  >
                    PIN ya uhakiki
                  </label>
                  <input
                    id="oc-pin"
                    type="password"
                    className={inputClass()}
                    value={offerPin}
                    onChange={(e) => setOfferPin(e.target.value)}
                    placeholder="Ingiza PIN"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div className="flex flex-wrap gap-3">
                  <button
                    type="submit"
                    disabled={offerBusy}
                    className="rounded-xl bg-gradient-to-r from-amber-400 to-yellow-500 px-6 py-3 text-sm font-bold text-slate-950 shadow-[0_8px_28px_rgba(251,191,36,0.35)] disabled:opacity-60"
                  >
                    {offerBusy ? 'Inatengeneza…' : 'TENGENEZA CODE'}
                  </button>
                  <button
                    type="button"
                    disabled={offerBusy || !generatedOfferCode}
                    onClick={() => void handleCopyOfferCode()}
                    className="rounded-xl border border-slate-600 bg-slate-800/90 px-6 py-3 text-sm font-bold text-slate-100 hover:bg-slate-700 disabled:opacity-40"
                  >
                    COPY CODE
                  </button>
                </div>
                {generatedOfferCode ? (
                  <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-amber-400/90">Code ya sasa</p>
                    <p className="mt-1 font-mono text-2xl font-bold tracking-[0.2em] text-amber-100">
                      {generatedOfferCode}
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">Bonyeza TENGENEZA CODE au baada ya kunakili utapata code mpya.</p>
                )}
              </form>
            </section>

            <section className="min-w-0 space-y-4 rounded-2xl border border-slate-700/60 bg-slate-950/40 p-4 ring-1 ring-white/[0.04] sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-slate-400">Historia ya offer codes.</p>
                <button
                  type="button"
                  disabled={offerLoading}
                  onClick={() => void loadOfferHistory()}
                  className="rounded-lg border border-slate-600 bg-slate-900/80 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                >
                  {offerLoading ? 'Inapakia…' : 'Onyesha upya'}
                </button>
              </div>

              <div className="overflow-x-auto rounded-xl border border-slate-700/50">
                <table className="min-w-[960px] w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-700/60 bg-slate-900/60 text-xs uppercase tracking-wide text-slate-400">
                      <th className="px-3 py-3 font-semibold">Code</th>
                      <th className="px-3 py-3 font-semibold">Muda</th>
                      <th className="px-3 py-3 font-semibold">Iliundwa</th>
                      <th className="px-3 py-3 font-semibold">Imetumia</th>
                      <th className="px-3 py-3 font-semibold">Wakati wa matumizi</th>
                      <th className="px-3 py-3 font-semibold">Mwisho wa code</th>
                      <th className="px-3 py-3 font-semibold">Hali</th>
                      <th className="px-3 py-3 font-semibold">Vitendo</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/80">
                    {offerLoading && offerRows.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="px-3 py-8 text-center text-slate-500">
                          Inapakia…
                        </td>
                      </tr>
                    ) : offerRows.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="px-3 py-8 text-center text-slate-500">
                          Hakuna codes bado.
                        </td>
                      </tr>
                    ) : (
                      offerRows.map((row) => {
                        const st = String(row.status ?? '').toUpperCase()
                        const bb = offerBusyCode === `b:${row.code}`
                        const ub = offerBusyCode === `u:${row.code}`
                        const db = offerBusyCode === `d:${row.code}`
                        const canBlock =
                          (st === 'UNUSED' || st === 'EXPIRED') && !row.deletedAt
                        const canUnblock = st === 'BLOCKED' && !row.deletedAt
                        const canDelete = !row.deletedAt && st !== 'USED'
                        return (
                          <tr key={row.id} className="bg-slate-950/20 hover:bg-slate-900/40">
                            <td className="whitespace-nowrap px-3 py-2.5 font-mono text-sm text-amber-100">{row.code}</td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-slate-300">{row.durationDays} siku</td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-slate-300">{formatAdminDateTime(row.createdAt)}</td>
                            <td className="max-w-[140px] truncate px-3 py-2.5 font-mono text-xs text-slate-400" title={row.usedByDevice || ''}>
                              {row.usedByDevice || '—'}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-slate-300">{formatAdminDateTime(row.usedAt)}</td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-slate-300">{formatAdminDateTime(row.expiresAt)}</td>
                            <td className="px-3 py-2.5">
                              <span
                                className={`inline-flex rounded-lg px-2 py-0.5 text-xs font-semibold ring-1 ${offerStatusStyle(st)}`}
                              >
                                {st}
                              </span>
                            </td>
                            <td className="px-3 py-2.5">
                              <div className="flex flex-wrap gap-1.5">
                                <button
                                  type="button"
                                  disabled={!canBlock || bb || ub || db}
                                  onClick={() => void handleOfferBlock(row.code)}
                                  className="rounded-md bg-rose-600/90 px-2 py-1 text-xs font-semibold text-white hover:bg-rose-500 disabled:opacity-40"
                                >
                                  {bb ? '…' : 'BLOCK'}
                                </button>
                                <button
                                  type="button"
                                  disabled={!canUnblock || bb || ub || db}
                                  onClick={() => void handleOfferUnblock(row.code)}
                                  className="rounded-md bg-emerald-700/90 px-2 py-1 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-40"
                                >
                                  {ub ? '…' : 'UNBLOCK'}
                                </button>
                                <button
                                  type="button"
                                  disabled={!canDelete || bb || ub || db}
                                  onClick={() => void handleOfferDelete(row.code)}
                                  className="rounded-md border border-slate-600 bg-slate-800/80 px-2 py-1 text-xs font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-40"
                                >
                                  {db ? '…' : 'DELETE'}
                                </button>
                              </div>
                            </td>
                          </tr>
                        )
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}
      </main>
    </>
  )
}

export default ManualSubscriptionPage
