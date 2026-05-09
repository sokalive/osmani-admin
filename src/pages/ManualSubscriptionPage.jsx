import { useState } from 'react'
import { Gift } from 'lucide-react'
import FlashMessage from '../components/FlashMessage'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import { postManualSubscriptionGrant } from '../lib/api'

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

function ManualSubscriptionPage() {
  const { showToast } = useToast()
  const [deviceId, setDeviceId] = useState('')
  const [durationDays, setDurationDays] = useState(7)
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    const d = deviceId.trim()
    if (!d) {
      showToast('error', 'Ingiza Device ID')
      return
    }
    if (!pin.trim()) {
      showToast('error', 'Ingiza PIN ya uhakiki')
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
        message: `Kifurushi kimewekwa. Muda wa mwisho: ${out.expiresAt ?? '—'} (grant #${out.grantId ?? '—'})`,
      })
      setPin('')
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
              <Gift className="h-5 w-5 text-amber-300" aria-hidden />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-400/90">Admin</p>
              <h1 className="text-2xl font-bold text-white sm:text-3xl">Toa Kifurushi</h1>
              <p className="mt-1 text-sm text-slate-400">Manual subscription · Device ID + muda</p>
            </div>
          </div>
        </header>

        <section className="max-w-xl space-y-5 rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6 ring-1 ring-white/[0.04]">
          <p className="text-sm text-slate-400">
            Tumia tu baada ya kuthibitisha Device ID. PIN inahakikiwa kwenye server; weka{' '}
            <code className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-amber-200/90">VITE_ADMIN_API_TOKEN</code>{' '}
            ili ulingane na API.
          </p>

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
                PIN ya uhakiki (server)
              </label>
              <input
                id="ms-pin"
                type="password"
                className={inputClass()}
                value={pin}
                onChange={(e) => setPin(e.target.value)}
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
      </main>
    </>
  )
}

export default ManualSubscriptionPage
