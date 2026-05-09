import { useCallback, useEffect, useState } from 'react'
import { Gift, Lock } from 'lucide-react'
import FlashMessage from '../components/FlashMessage'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import {
  getManualSubscriptionPinStatus,
  postManualSubscriptionGrant,
  postManualSubscriptionSetupPin,
} from '../lib/api'

const DURATIONS = [
  { days: 1, label: 'Siku 1' },
  { days: 7, label: 'Siku 7' },
  { days: 30, label: 'Siku 30' },
  { days: 90, label: 'Siku 90' },
]

/** Must match server MANUAL_SUBSCRIPTION_PIN_MIN_LENGTH */
const PIN_MIN_LEN = 6

function inputClass() {
  return 'w-full rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-500/60 focus:outline-none focus:ring-2 focus:ring-amber-500/25'
}

function selectClass() {
  return inputClass()
}

function ManualSubscriptionPage() {
  const { showToast } = useToast()
  const [pinConfigured, setPinConfigured] = useState(null)
  const [statusLoading, setStatusLoading] = useState(true)

  const [deviceId, setDeviceId] = useState('')
  const [durationDays, setDurationDays] = useState(7)
  const [grantPin, setGrantPin] = useState('')
  const [busy, setBusy] = useState(false)

  const [newPin, setNewPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [setupBusy, setSetupBusy] = useState(false)

  const [flash, setFlash] = useState(null)

  const loadPinStatus = useCallback(async () => {
    setStatusLoading(true)
    try {
      const s = await getManualSubscriptionPinStatus()
      setPinConfigured(Boolean(s?.configured))
    } catch (e) {
      showToast('error', e?.message || 'Could not load PIN status')
      setPinConfigured(null)
    } finally {
      setStatusLoading(false)
    }
  }, [showToast])

  useEffect(() => {
    loadPinStatus()
  }, [loadPinStatus])

  async function handleSetupSubmit(e) {
    e.preventDefault()
    if (newPin.length < PIN_MIN_LEN || confirmPin.length < PIN_MIN_LEN) {
      showToast('error', `PIN lazima iwe angalau herufi ${PIN_MIN_LEN}`)
      return
    }
    if (newPin !== confirmPin) {
      showToast('error', 'PIN hazilingani')
      return
    }
    setSetupBusy(true)
    try {
      await postManualSubscriptionSetupPin({ pin: newPin, confirmPin })
      setFlash({ type: 'success', message: 'PIN imehifadhiwa kwa usalama. Sasa unaweza kutoa kifurushi.' })
      setNewPin('')
      setConfirmPin('')
      setPinConfigured(true)
    } catch (err) {
      showToast('error', err?.message || 'Imeshindikana')
    } finally {
      setSetupBusy(false)
    }
  }

  async function handleGrantSubmit(e) {
    e.preventDefault()
    const d = deviceId.trim()
    if (!d) {
      showToast('error', 'Ingiza Device ID')
      return
    }
    if (!grantPin.trim()) {
      showToast('error', 'Ingiza PIN ya uhakiki')
      return
    }
    setBusy(true)
    try {
      const out = await postManualSubscriptionGrant({
        deviceId: d,
        durationDays,
        pin: grantPin.trim(),
      })
      setFlash({
        type: 'success',
        message: `Kifurushi kimewekwa. Muda wa mwisho: ${out.expiresAt ?? '—'} (grant #${out.grantId ?? '—'})`,
      })
      setGrantPin('')
    } catch (err) {
      showToast('error', err?.message || 'Imeshindikana')
    } finally {
      setBusy(false)
    }
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
              {pinConfigured === false ? (
                <Lock className="h-5 w-5 text-amber-300" aria-hidden />
              ) : (
                <Gift className="h-5 w-5 text-amber-300" aria-hidden />
              )}
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-400/90">Admin</p>
              <h1 className="text-2xl font-bold text-white sm:text-3xl">
                {pinConfigured === false ? 'Set Admin PIN' : 'Toa Kifurushi'}
              </h1>
              <p className="mt-1 text-sm text-slate-400">
                {pinConfigured === false
                  ? 'Weka PIN ya kwanza · inahifadhiwa kwenye server (hash)'
                  : 'Manual subscription · Device ID + muda'}
              </p>
            </div>
          </div>
        </header>

        {statusLoading ? (
          <p className="text-sm text-slate-400">Inapakia…</p>
        ) : pinConfigured === false ? (
          <section className="max-w-xl space-y-5 rounded-2xl border border-amber-600/40 bg-slate-950/40 p-6 ring-1 ring-amber-500/15">
            <p className="text-sm text-slate-300">
              Bado hakuna PIN ya uhakiki ya Toa Kifurushi kwenye server. Weka PIN mpya —{' '}
              <strong className="text-amber-200/95">haitahifadhiwa kwa maandishi wazi</strong>, ni hash tu.
            </p>

            <form onSubmit={handleSetupSubmit} className="space-y-4">
              <div>
                <label htmlFor="ms-new-pin" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">
                  PIN mpya
                </label>
                <input
                  id="ms-new-pin"
                  type="password"
                  className={inputClass()}
                  value={newPin}
                  onChange={(e) => setNewPin(e.target.value)}
                  autoComplete="new-password"
                  minLength={PIN_MIN_LEN}
                />
              </div>
              <div>
                <label htmlFor="ms-confirm-pin" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Thibitisha PIN
                </label>
                <input
                  id="ms-confirm-pin"
                  type="password"
                  className={inputClass()}
                  value={confirmPin}
                  onChange={(e) => setConfirmPin(e.target.value)}
                  autoComplete="new-password"
                  minLength={PIN_MIN_LEN}
                />
              </div>
              <button
                type="submit"
                disabled={setupBusy}
                className="w-full rounded-xl bg-gradient-to-r from-amber-400 to-yellow-500 py-3 text-sm font-bold text-slate-950 shadow-[0_8px_28px_rgba(251,191,36,0.35)] transition-transform hover:scale-[1.01] disabled:opacity-60 sm:w-auto sm:min-w-[200px] sm:px-8"
              >
                {setupBusy ? 'Inahifadhi…' : 'Hifadhi PIN'}
              </button>
            </form>
          </section>
        ) : pinConfigured === true ? (
          <section className="max-w-xl space-y-5 rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6 ring-1 ring-white/[0.04]">
            <p className="text-sm text-slate-400">
              Tumia tu baada ya kuthibitisha Device ID. PIN inahakikiwa kwenye server; weka{' '}
              <code className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-amber-200/90">VITE_ADMIN_API_TOKEN</code>{' '}
              ili ulingane na API.
            </p>

            <form onSubmit={handleGrantSubmit} className="space-y-4">
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
                  value={grantPin}
                  onChange={(e) => setGrantPin(e.target.value)}
                  placeholder="••••••"
                  autoComplete="current-password"
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
        ) : (
          <p className="text-sm text-red-300/90">Haiwezi kuonyesha fomu. Jaribu tena au angalia token.</p>
        )}
      </main>
    </>
  )
}

export default ManualSubscriptionPage
