import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CalendarClock, Gift, History, Ticket } from 'lucide-react'
import FlashMessage from '../components/FlashMessage'
import SecurityPinModal from '../components/SecurityPinModal'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import {
  deleteManualSubscriptionGrant,
  deleteOfferCode,
  getManualSubscriptionHistory,
  getOfferCodesHistory,
  getPlans,
  postManualSubscriptionBlock,
  postManualSubscriptionBulkBlock,
  postManualSubscriptionBulkUnblock,
  postManualSubscriptionGrant,
  postManualSubscriptionGrantCustom,
  postManualSubscriptionHistoryBulkDelete,
  postManualSubscriptionUnblock,
  postOfferCodeBlock,
  postOfferCodesBulkBlock,
  postOfferCodesBulkDelete,
  postOfferCodesBulkUnblock,
  postOfferCodeGenerate,
  postOfferCodeUnblock,
} from '../lib/api'
import { formatAdminDateTime, adminDateAndTimeToIso, adminDateFromIso, adminTimeFromIso } from '../lib/formatAdminDateTime'
import {
  filterSelectableSubscriptionPlans,
  formatManualGrantPlanLabel,
  planDurationDays,
} from '../lib/subscriptionPlanOptions'

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

/** Match server `normalizeOfferCode` (6 digits) for bulk payloads. */
function digitsOfferCode(raw) {
  const s = String(raw ?? '').replace(/\D/g, '')
  return s.length === 6 ? s : null
}

function bulkResultToast(body) {
  if (!body || typeof body !== 'object') return { tone: 'success', msg: 'Imefanikiwa' }
  const nf = Number(body.not_found ?? body.notFound ?? 0) || 0
  if (typeof body.blocked === 'number') {
    const ok = body.blocked
    if (ok === 0 && nf > 0) return { tone: 'error', msg: `BLOCK: hakuna kilichofanikiwa (${nf} hakuna rekodi)` }
    if (nf > 0) return { tone: 'success', msg: `BLOCK: ${ok} vifaa. Angalizo: ${nf} hakuna rekodi ya subscription` }
    return { tone: 'success', msg: `BLOCK: vifaa ${ok}` }
  }
  if (typeof body.unblocked === 'number') {
    const ok = body.unblocked
    if (ok === 0 && nf > 0) return { tone: 'error', msg: `UNBLOCK: hakuna kilichofanikiwa (${nf})` }
    if (nf > 0) return { tone: 'success', msg: `UNBLOCK: ${ok} vifaa. Angalizo: ${nf} hakuna rekodi` }
    return { tone: 'success', msg: `UNBLOCK: vifaa ${ok}` }
  }
  if (typeof body.deleted === 'number') {
    const ok = body.deleted
    if (ok === 0 && nf > 0) return { tone: 'error', msg: `FUTA: hakuna kilichofanikiwa (${nf})` }
    if (nf > 0) return { tone: 'success', msg: `FUTA: ${ok} rekodi. Angalizo: ${nf} hazijapatikana` }
    return { tone: 'success', msg: `FUTA: rekodi ${ok}` }
  }
  return { tone: 'success', msg: 'Imefanikiwa' }
}

function eatNowDateTimeFields() {
  const iso = new Date().toISOString()
  return {
    date: adminDateFromIso(iso) || '',
    time: adminTimeFromIso(iso) || '12:00',
  }
}

function expiryFieldsFromPlan(plan, startDate, startTime) {
  const startIso = adminDateAndTimeToIso(startDate, startTime)
  const days = planDurationDays(plan) || 7
  const base = startIso ? new Date(startIso).getTime() : Date.now()
  const expIso = new Date(base + days * 86400000).toISOString()
  return {
    date: adminDateFromIso(expIso) || '',
    time: adminTimeFromIso(expIso) || '12:00',
  }
}

function ManualSubscriptionPage() {
  const { showToast } = useToast()
  const [tab, setTab] = useState('grant')
  const [deviceId, setDeviceId] = useState('')
  const [grantPhone, setGrantPhone] = useState('')
  const [plans, setPlans] = useState([])
  const [plansLoading, setPlansLoading] = useState(true)
  const [selectedPlanId, setSelectedPlanId] = useState('')
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState(null)

  const [customDeviceId, setCustomDeviceId] = useState('')
  const [customPhone, setCustomPhone] = useState('')
  const [customPlanId, setCustomPlanId] = useState('')
  const [customBusy, setCustomBusy] = useState(false)
  const [customStartDate, setCustomStartDate] = useState('')
  const [customStartTime, setCustomStartTime] = useState('')
  const [customExpireDate, setCustomExpireDate] = useState('')
  const [customExpireTime, setCustomExpireTime] = useState('')

  const [historyRows, setHistoryRows] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyBusyId, setHistoryBusyId] = useState(null)

  const [offerSelectedPlanId, setOfferSelectedPlanId] = useState('')
  const [offerPin, setOfferPin] = useState('')
  const [generatedOfferCode, setGeneratedOfferCode] = useState('')
  const [offerBusy, setOfferBusy] = useState(false)
  const [offerRows, setOfferRows] = useState([])
  const [offerLoading, setOfferLoading] = useState(false)
  const [offerBusyCode, setOfferBusyCode] = useState(null)

  const [histSelected, setHistSelected] = useState(() => new Set())
  const [offerSelected, setOfferSelected] = useState(() => new Set())
  const [bulkPinExec, setBulkPinExec] = useState(null)
  const [bulkPinBusy, setBulkPinBusy] = useState(false)
  const [bulkPinError, setBulkPinError] = useState('')

  const selectablePlans = useMemo(() => filterSelectableSubscriptionPlans(plans), [plans])

  const selectedPlan = useMemo(
    () => selectablePlans.find((p) => String(p.id) === String(selectedPlanId)) ?? null,
    [selectablePlans, selectedPlanId],
  )

  const offerSelectedPlan = useMemo(
    () => selectablePlans.find((p) => String(p.id) === String(offerSelectedPlanId)) ?? null,
    [selectablePlans, offerSelectedPlanId],
  )

  const customSelectedPlan = useMemo(
    () => selectablePlans.find((p) => String(p.id) === String(customPlanId)) ?? null,
    [selectablePlans, customPlanId],
  )

  const loadPlans = useCallback(async () => {
    setPlansLoading(true)
    try {
      const rows = await getPlans()
      const list = filterSelectableSubscriptionPlans(Array.isArray(rows) ? rows : [])
      setPlans(list)
      setSelectedPlanId((prev) => {
        if (prev && list.some((p) => String(p.id) === String(prev))) return prev
        return list[0] ? String(list[0].id) : ''
      })
      setOfferSelectedPlanId((prev) => {
        if (prev && list.some((p) => String(p.id) === String(prev))) return prev
        return list[0] ? String(list[0].id) : ''
      })
      setCustomPlanId((prev) => {
        if (prev && list.some((p) => String(p.id) === String(prev))) return prev
        return list[0] ? String(list[0].id) : ''
      })
    } catch (err) {
      showToast('error', err?.message || 'Mipango haikuweza kupakiwa')
      setPlans([])
      setSelectedPlanId('')
      setOfferSelectedPlanId('')
      setCustomPlanId('')
    } finally {
      setPlansLoading(false)
    }
  }, [showToast])

  useEffect(() => {
    void loadPlans()
  }, [loadPlans])

  useEffect(() => {
    if (tab !== 'history') setHistSelected(new Set())
  }, [tab])

  useEffect(() => {
    if (tab !== 'offer') setOfferSelected(new Set())
  }, [tab])

  const customPlanInitRef = useRef('')

  useEffect(() => {
    if (tab !== 'custom' || !customSelectedPlan) return
    const planKey = String(customPlanId)
    if (customPlanInitRef.current === planKey && customStartDate) return
    customPlanInitRef.current = planKey
    const start = eatNowDateTimeFields()
    setCustomStartDate(start.date)
    setCustomStartTime(start.time)
    const exp = expiryFieldsFromPlan(customSelectedPlan, start.date, start.time)
    setCustomExpireDate(exp.date)
    setCustomExpireTime(exp.time)
  }, [tab, customPlanId, customSelectedPlan])

  useEffect(() => {
    if (tab !== 'custom') customPlanInitRef.current = ''
  }, [tab])

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
    const days = planDurationDays(offerSelectedPlan)
    if (!days || !offerSelectedPlan) {
      showToast('error', 'Chagua kifurushi')
      return
    }
    setOfferBusy(true)
    try {
      const out = await postOfferCodeGenerate({
        durationDays: days,
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
    const days = planDurationDays(offerSelectedPlan)
    if (!days || !offerSelectedPlan) {
      showToast('error', 'Chagua kifurushi')
      return
    }
    setOfferBusy(true)
    try {
      const out = await postOfferCodeGenerate({
        durationDays: days,
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
    const phone = grantPhone.trim()
    if (!phone) {
      showToast('error', 'Ingiza namba ya simu')
      return
    }
    const days = planDurationDays(selectedPlan)
    if (!days || !selectedPlan) {
      showToast('error', 'Chagua kifurushi')
      return
    }
    setBusy(true)
    try {
      const out = await postManualSubscriptionGrant({
        deviceId: d,
        durationDays: days,
        phone,
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

  async function handleCustomSubmit(e) {
    e.preventDefault()
    const d = customDeviceId.trim()
    if (!d) {
      showToast('error', 'Ingiza Device ID')
      return
    }
    const phone = customPhone.trim()
    if (!phone) {
      showToast('error', 'Ingiza namba ya simu')
      return
    }
    if (!customSelectedPlan) {
      showToast('error', 'Chagua kifurushi')
      return
    }
    const startedAt = adminDateAndTimeToIso(customStartDate, customStartTime)
    const expiresAt = adminDateAndTimeToIso(customExpireDate, customExpireTime)
    if (!startedAt || !expiresAt) {
      showToast('error', 'Tarehe na saa za kuanza na kuisha zinahitajika')
      return
    }
    if (new Date(expiresAt).getTime() <= new Date(startedAt).getTime()) {
      showToast('error', 'Tarehe ya kuisha lazima iwe baada ya tarehe ya kuanza')
      return
    }
    setCustomBusy(true)
    try {
      const out = await postManualSubscriptionGrantCustom({
        deviceId: d,
        planId: customSelectedPlan.id,
        startedAt,
        expiresAt,
        phone,
      })
      setFlash({
        type: 'success',
        message: `Kifurushi kimewekwa. Muda wa mwisho: ${formatAdminDateTime(out.expiresAt, { fallback: '—' })} (grant #${out.grantId ?? '—'})`,
      })
      void loadHistory()
    } catch (err) {
      showToast('error', err?.message || 'Imeshindikana')
    } finally {
      setCustomBusy(false)
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

  const allHistChecked = useMemo(
    () => historyRows.length > 0 && historyRows.every((r) => histSelected.has(Number(r.id))),
    [historyRows, histSelected],
  )

  const allOfferChecked = useMemo(
    () =>
      offerRows.length > 0 &&
      offerRows.every((r) => {
        const k = digitsOfferCode(r.code)
        return k != null && offerSelected.has(k)
      }),
    [offerRows, offerSelected],
  )

  async function handleBulkPinSubmit(pin) {
    if (typeof bulkPinExec !== 'function') return
    setBulkPinBusy(true)
    setBulkPinError('')
    try {
      const summary = await bulkPinExec(pin)
      setBulkPinExec(null)
      await loadHistory()
      await loadOfferHistory()
      const { tone, msg } = bulkResultToast(summary)
      showToast(tone, msg)
    } catch (err) {
      const msg = err?.message || 'Imeshindikana'
      setBulkPinError(msg)
      showToast('error', msg)
    } finally {
      setBulkPinBusy(false)
    }
  }

  return (
    <>
      <SecurityPinModal
        open={bulkPinExec != null}
        title="Ingiza Security PIN"
        errorText={bulkPinError}
        busy={bulkPinBusy}
        onClose={() => !bulkPinBusy && setBulkPinExec(null)}
        onSubmit={handleBulkPinSubmit}
      />
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
              <p className="mt-1 text-sm text-slate-400">Manual subscription · Device ID + kifurushi kutoka mipango</p>
            </div>
          </div>
        </header>

        <div className="flex flex-wrap gap-2">
          <button type="button" className={tabBtn(tab === 'grant')} onClick={() => setTab('grant')}>
            Toa Kifurushi
          </button>
          <button type="button" className={tabBtn(tab === 'custom')} onClick={() => setTab('custom')}>
            <span className="inline-flex items-center gap-2">
              <CalendarClock className="h-4 w-4 opacity-90" aria-hidden />
              Custom Subscription
            </span>
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
                <label htmlFor="ms-plan" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Kifurushi
                </label>
                <select
                  id="ms-plan"
                  className={selectClass()}
                  value={selectedPlanId}
                  onChange={(e) => setSelectedPlanId(e.target.value)}
                  disabled={plansLoading || selectablePlans.length === 0}
                >
                  {plansLoading ? (
                    <option value="">Inapakia mipango…</option>
                  ) : selectablePlans.length === 0 ? (
                    <option value="">Hakuna mipango hai</option>
                  ) : (
                    selectablePlans.map((p) => (
                      <option key={p.id} value={String(p.id)}>
                        {formatManualGrantPlanLabel(p)}
                      </option>
                    ))
                  )}
                </select>
              </div>

              <div>
                <label htmlFor="ms-phone" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Phone Number
                </label>
                <input
                  id="ms-phone"
                  type="tel"
                  className={inputClass()}
                  value={grantPhone}
                  onChange={(e) => setGrantPhone(e.target.value)}
                  placeholder="+2557XXXXXXXX"
                  autoComplete="tel"
                />
              </div>

              <button
                type="submit"
                disabled={busy || plansLoading || !selectedPlan}
                className="w-full rounded-xl bg-gradient-to-r from-amber-400 to-yellow-500 py-3 text-sm font-bold text-slate-950 shadow-[0_8px_28px_rgba(251,191,36,0.35)] transition-transform hover:scale-[1.01] disabled:opacity-60 sm:w-auto sm:min-w-[200px] sm:px-8"
              >
                {busy ? 'Inaweka…' : 'Weka Kifurushi'}
              </button>
            </form>
          </section>
        ) : tab === 'custom' ? (
          <section className="max-w-xl space-y-5 rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6 ring-1 ring-white/[0.04]">
            <p className="text-sm text-slate-400">
              Weka kifurushi kwa muda maalum — chagua tarehe na saa za kuanza na kuisha (EAT).
            </p>
            <form onSubmit={handleCustomSubmit} className="space-y-4">
              <div>
                <label htmlFor="cs-device" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Device ID
                </label>
                <input
                  id="cs-device"
                  className={inputClass()}
                  value={customDeviceId}
                  onChange={(e) => setCustomDeviceId(e.target.value)}
                  placeholder="000865b4f965515c"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              <div>
                <label htmlFor="cs-plan" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Kifurushi
                </label>
                <select
                  id="cs-plan"
                  className={selectClass()}
                  value={customPlanId}
                  onChange={(e) => setCustomPlanId(e.target.value)}
                  disabled={plansLoading || selectablePlans.length === 0}
                >
                  {plansLoading ? (
                    <option value="">Inapakia mipango…</option>
                  ) : selectablePlans.length === 0 ? (
                    <option value="">Hakuna mipango hai</option>
                  ) : (
                    selectablePlans.map((p) => (
                      <option key={p.id} value={String(p.id)}>
                        {formatManualGrantPlanLabel(p)}
                      </option>
                    ))
                  )}
                </select>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="cs-start-date" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Start Date
                  </label>
                  <input
                    id="cs-start-date"
                    type="date"
                    className={inputClass()}
                    value={customStartDate}
                    onChange={(e) => setCustomStartDate(e.target.value)}
                  />
                </div>
                <div>
                  <label htmlFor="cs-start-time" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Start Time
                  </label>
                  <input
                    id="cs-start-time"
                    type="time"
                    className={inputClass()}
                    value={customStartTime}
                    onChange={(e) => setCustomStartTime(e.target.value)}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="cs-expire-date" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Expiry Date
                  </label>
                  <input
                    id="cs-expire-date"
                    type="date"
                    className={inputClass()}
                    value={customExpireDate}
                    onChange={(e) => setCustomExpireDate(e.target.value)}
                  />
                </div>
                <div>
                  <label htmlFor="cs-expire-time" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Expiry Time
                  </label>
                  <input
                    id="cs-expire-time"
                    type="time"
                    className={inputClass()}
                    value={customExpireTime}
                    onChange={(e) => setCustomExpireTime(e.target.value)}
                  />
                </div>
              </div>

              <div>
                <label htmlFor="cs-phone" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Phone Number
                </label>
                <input
                  id="cs-phone"
                  type="tel"
                  className={inputClass()}
                  value={customPhone}
                  onChange={(e) => setCustomPhone(e.target.value)}
                  placeholder="+2557XXXXXXXX"
                  autoComplete="tel"
                />
              </div>

              <button
                type="submit"
                disabled={customBusy || plansLoading || !customSelectedPlan}
                className="w-full rounded-xl bg-gradient-to-r from-amber-400 to-yellow-500 py-3 text-sm font-bold text-slate-950 shadow-[0_8px_28px_rgba(251,191,36,0.35)] transition-transform hover:scale-[1.01] disabled:opacity-60 sm:w-auto sm:min-w-[200px] sm:px-8"
              >
                {customBusy ? 'Inaweka…' : 'Weka Custom Subscription'}
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

            {histSelected.size > 0 ? (
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/5 px-3 py-2">
                <span className="text-xs font-semibold text-amber-100">
                  Umechagua {histSelected.size}
                </span>
                <button
                  type="button"
                  disabled={bulkPinBusy}
                  onClick={() => {
                    const deviceIds = [
                      ...new Set(
                        historyRows
                          .filter((r) => histSelected.has(Number(r.id)))
                          .map((r) => String(r.deviceId ?? '').trim()),
                      ),
                    ].filter(Boolean)
                    if (deviceIds.length === 0) {
                      showToast('error', 'Hakuna device IDs')
                      return
                    }
                    setBulkPinError('')
                    setBulkPinExec(() => async (securityPin) => {
                      const out = await postManualSubscriptionBulkBlock({ deviceIds, securityPin })
                      setHistSelected(new Set())
                      return out
                    })
                  }}
                  className="rounded-md bg-rose-600/90 px-2.5 py-1.5 text-[11px] font-bold text-white hover:bg-rose-500 disabled:opacity-40"
                >
                  BLOCK ULIOCHAGUA
                </button>
                <button
                  type="button"
                  disabled={bulkPinBusy}
                  onClick={() => {
                    const deviceIds = [
                      ...new Set(
                        historyRows
                          .filter((r) => histSelected.has(Number(r.id)))
                          .map((r) => String(r.deviceId ?? '').trim()),
                      ),
                    ].filter(Boolean)
                    if (deviceIds.length === 0) {
                      showToast('error', 'Hakuna device IDs')
                      return
                    }
                    setBulkPinError('')
                    setBulkPinExec(() => async (securityPin) => {
                      const out = await postManualSubscriptionBulkUnblock({ deviceIds, securityPin })
                      setHistSelected(new Set())
                      return out
                    })
                  }}
                  className="rounded-md bg-emerald-700/90 px-2.5 py-1.5 text-[11px] font-bold text-white hover:bg-emerald-600 disabled:opacity-40"
                >
                  UNBLOCK ULIOCHAGUA
                </button>
                <button
                  type="button"
                  disabled={bulkPinBusy}
                  onClick={() => {
                    const grantIds = [
                      ...new Set(
                        historyRows
                          .filter((r) => histSelected.has(Number(r.id)))
                          .map((r) => Number(r.id)),
                      ),
                    ].filter((n) => Number.isFinite(n) && n >= 1)
                    if (grantIds.length === 0) return
                    if (
                      !window.confirm(
                        `Futa rekodi ${grantIds.length} kwenye historia? (Huduma ya kifurushi hubaki.)`,
                      )
                    ) {
                      return
                    }
                    setBulkPinError('')
                    setBulkPinExec(() => async (securityPin) => {
                      if (import.meta.env.DEV) {
                        console.info('[manual_history_bulk_delete_client]', {
                          grantIds,
                          selectedCount: histSelected.size,
                          matchedRows: grantIds.length,
                        })
                      }
                      const out = await postManualSubscriptionHistoryBulkDelete({ grantIds, securityPin })
                      setHistSelected(new Set())
                      return out
                    })
                  }}
                  className="rounded-md border border-slate-600 bg-slate-800/90 px-2.5 py-1.5 text-[11px] font-bold text-slate-200 hover:bg-slate-700 disabled:opacity-40"
                >
                  FUTA ULIOCHAGUA
                </button>
              </div>
            ) : null}

            <div className="overflow-x-auto rounded-xl border border-slate-700/50">
              <table className="min-w-[920px] w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-700/60 bg-slate-900/60 text-xs uppercase tracking-wide text-slate-400">
                    <th className="w-10 px-2 py-3">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-slate-500 bg-slate-900 text-amber-500"
                        checked={allHistChecked}
                        onChange={() =>
                          setHistSelected((prev) => {
                            if (
                              historyRows.length > 0 &&
                              historyRows.every((r) => prev.has(Number(r.id)))
                            ) {
                              return new Set()
                            }
                            return new Set(historyRows.map((r) => Number(r.id)))
                          })
                        }
                        title="Chagua zote"
                        aria-label="Chagua zote"
                      />
                    </th>
                    <th className="px-3 py-3 font-semibold">Device ID</th>
                    <th className="px-3 py-3 font-semibold">Muda</th>
                    <th className="px-3 py-3 font-semibold">Aina</th>
                    <th className="px-3 py-3 font-semibold">Alipotolewa</th>
                    <th className="px-3 py-3 font-semibold">Mwisho</th>
                    <th className="px-3 py-3 font-semibold">Hali</th>
                    <th className="px-3 py-3 font-semibold">Vitendo</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80">
                  {historyLoading && historyRows.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-3 py-8 text-center text-slate-500">
                        Inapakia…
                      </td>
                    </tr>
                  ) : historyRows.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-3 py-8 text-center text-slate-500">
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
                          <td className="px-2 py-2.5 align-middle">
                            <input
                              type="checkbox"
                              className="h-4 w-4 rounded border-slate-500 bg-slate-900 text-amber-500"
                              checked={histSelected.has(Number(row.id))}
                              onChange={() =>
                                setHistSelected((prev) => {
                                  const n = new Set(prev)
                                  const id = Number(row.id)
                                  if (n.has(id)) n.delete(id)
                                  else n.add(id)
                                  return n
                                })
                              }
                              aria-label={`Chagua ${shortDev}`}
                            />
                          </td>
                          <td className="max-w-[200px] truncate px-3 py-2.5 font-mono text-xs text-slate-200" title={row.deviceId}>
                            {shortDev}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-slate-300">
                            {row.customExpiry
                              ? row.planName
                                ? `${row.planName} (custom)`
                                : 'Custom'
                              : `${row.durationDays} siku`}
                          </td>
                          <td className="px-3 py-2.5">
                            {row.customExpiry ? (
                              <span className="inline-flex rounded-lg bg-violet-500/15 px-2 py-0.5 text-xs font-semibold text-violet-200 ring-1 ring-violet-500/30">
                                Custom
                              </span>
                            ) : (
                              <span className="text-xs text-slate-500">Standard</span>
                            )}
                            {row.createdBy ? (
                              <span className="mt-1 block max-w-[120px] truncate text-[10px] text-slate-500" title={row.createdBy}>
                                {row.createdBy}
                              </span>
                            ) : null}
                          </td>
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
                    htmlFor="oc-plan"
                    className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400"
                  >
                    Kifurushi
                  </label>
                  <select
                    id="oc-plan"
                    className={selectClass()}
                    value={offerSelectedPlanId}
                    onChange={(e) => setOfferSelectedPlanId(e.target.value)}
                    disabled={plansLoading || selectablePlans.length === 0}
                  >
                    {plansLoading ? (
                      <option value="">Inapakia mipango…</option>
                    ) : selectablePlans.length === 0 ? (
                      <option value="">Hakuna mipango hai</option>
                    ) : (
                      selectablePlans.map((p) => (
                        <option key={p.id} value={String(p.id)}>
                          {formatManualGrantPlanLabel(p)}
                        </option>
                      ))
                    )}
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
                    disabled={offerBusy || plansLoading || !offerSelectedPlan}
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

              {offerSelected.size > 0 ? (
                <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/5 px-3 py-2">
                  <span className="text-xs font-semibold text-amber-100">
                    Umechagua {offerSelected.size}
                  </span>
                  <button
                    type="button"
                    disabled={bulkPinBusy}
                    onClick={() => {
                      const codes = [
                        ...new Set(
                          [...offerSelected].map((c) => digitsOfferCode(c)).filter(Boolean),
                        ),
                      ]
                      if (codes.length === 0) {
                        showToast('error', 'Hakuna codes sahihi (tarakimu 6)')
                        return
                      }
                      setBulkPinError('')
                      setBulkPinExec(() => async (securityPin) => {
                        const out = await postOfferCodesBulkBlock({ codes, securityPin })
                        setOfferSelected(new Set())
                        return out
                      })
                    }}
                    className="rounded-md bg-rose-600/90 px-2.5 py-1.5 text-[11px] font-bold text-white hover:bg-rose-500 disabled:opacity-40"
                  >
                    BLOCK ULIOCHAGUA
                  </button>
                  <button
                    type="button"
                    disabled={bulkPinBusy}
                    onClick={() => {
                      const codes = [
                        ...new Set(
                          [...offerSelected].map((c) => digitsOfferCode(c)).filter(Boolean),
                        ),
                      ]
                      if (codes.length === 0) {
                        showToast('error', 'Hakuna codes sahihi (tarakimu 6)')
                        return
                      }
                      setBulkPinError('')
                      setBulkPinExec(() => async (securityPin) => {
                        const out = await postOfferCodesBulkUnblock({ codes, securityPin })
                        setOfferSelected(new Set())
                        return out
                      })
                    }}
                    className="rounded-md bg-emerald-700/90 px-2.5 py-1.5 text-[11px] font-bold text-white hover:bg-emerald-600 disabled:opacity-40"
                  >
                    UNBLOCK ULIOCHAGUA
                  </button>
                  <button
                    type="button"
                    disabled={bulkPinBusy}
                    onClick={() => {
                      const codes = [
                        ...new Set(
                          [...offerSelected].map((c) => digitsOfferCode(c)).filter(Boolean),
                        ),
                      ]
                      if (codes.length === 0) {
                        showToast('error', 'Hakuna codes sahihi (tarakimu 6)')
                        return
                      }
                      if (
                        !window.confirm(
                          `Futa au futa rekodi kwa codes ${codes.length}? (Server atarudisha kosa kwa code zisizoweza.)`,
                        )
                      ) {
                        return
                      }
                      setBulkPinError('')
                      setBulkPinExec(() => async (securityPin) => {
                        const out = await postOfferCodesBulkDelete({ codes, securityPin })
                        setOfferSelected(new Set())
                        return out
                      })
                    }}
                    className="rounded-md border border-slate-600 bg-slate-800/90 px-2.5 py-1.5 text-[11px] font-bold text-slate-200 hover:bg-slate-700 disabled:opacity-40"
                  >
                    FUTA ULIOCHAGUA
                  </button>
                </div>
              ) : null}

              <div className="overflow-x-auto rounded-xl border border-slate-700/50">
                <table className="min-w-[1000px] w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-700/60 bg-slate-900/60 text-xs uppercase tracking-wide text-slate-400">
                      <th className="w-10 px-2 py-3">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-slate-500 bg-slate-900 text-amber-500"
                          checked={allOfferChecked}
                          onChange={() =>
                            setOfferSelected((prev) => {
                              if (
                                offerRows.length > 0 &&
                                offerRows.every((r) => {
                                  const k = digitsOfferCode(r.code)
                                  return k && prev.has(k)
                                })
                              ) {
                                return new Set()
                              }
                              return new Set(
                                offerRows.map((r) => digitsOfferCode(r.code)).filter(Boolean),
                              )
                            })
                          }
                          title="Chagua zote"
                          aria-label="Chagua zote"
                        />
                      </th>
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
                        <td colSpan={9} className="px-3 py-8 text-center text-slate-500">
                          Inapakia…
                        </td>
                      </tr>
                    ) : offerRows.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="px-3 py-8 text-center text-slate-500">
                          Hakuna codes bado.
                        </td>
                      </tr>
                    ) : (
                      offerRows.map((row) => {
                        const st = String(row.status ?? '').toUpperCase()
                        const codeKey = digitsOfferCode(row.code)
                        const bb = offerBusyCode === `b:${row.code}`
                        const ub = offerBusyCode === `u:${row.code}`
                        const db = offerBusyCode === `d:${row.code}`
                        const canBlock =
                          (st === 'UNUSED' || st === 'EXPIRED') && !row.deletedAt
                        const canUnblock = st === 'BLOCKED' && !row.deletedAt
                        const canDelete = !row.deletedAt && st !== 'USED'
                        return (
                          <tr key={row.id} className="bg-slate-950/20 hover:bg-slate-900/40">
                            <td className="px-2 py-2.5 align-middle">
                              <input
                                type="checkbox"
                                className="h-4 w-4 rounded border-slate-500 bg-slate-900 text-amber-500"
                                disabled={!codeKey}
                                checked={Boolean(codeKey && offerSelected.has(codeKey))}
                                onChange={() =>
                                  setOfferSelected((prev) => {
                                    const n = new Set(prev)
                                    if (!codeKey) return n
                                    if (n.has(codeKey)) n.delete(codeKey)
                                    else n.add(codeKey)
                                    return n
                                  })
                                }
                                aria-label={`Chagua code ${row.code}`}
                              />
                            </td>
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
