import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Loader2, Smartphone, Wifi, XCircle } from 'lucide-react'
import FlashMessage from '../components/FlashMessage'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import { API_ORIGIN } from '../lib/api'
import {
  getPaymentStatus,
  getPlans,
  getZenopaySettings,
  postCreatePayment,
  postZenopayTest,
  putZenopaySettings,
} from '../lib/api'

function defaultSettings() {
  return {
    environment: 'sandbox',
    apiEndpoint: '',
    accountId: '',
    apiKey: '',
    hasApiKey: false,
    apiKeyMasked: '',
    webhookUrl: '',
    lastTestAt: null,
    lastTestOk: null,
    lastTestMessage: '',
  }
}

function maskKey(key) {
  if (!key || key.length < 8) return '••••••••'
  return `${key.slice(0, 4)}${'•'.repeat(Math.min(16, key.length - 8))}${key.slice(-4)}`
}

function inputClass() {
  return 'w-full rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-500/60 focus:outline-none focus:ring-2 focus:ring-amber-500/25'
}

function labelClass() {
  return 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400'
}

function ZenoPayPage() {
  const { showToast } = useToast()
  const [cfg, setCfg] = useState(() => defaultSettings())
  const [draft, setDraft] = useState(() => ({ ...defaultSettings() }))
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [flash, setFlash] = useState(null)

  const [checkoutPlans, setCheckoutPlans] = useState([])
  const [payPhone, setPayPhone] = useState('')
  const [payPlanId, setPayPlanId] = useState('')
  const [checkoutOrderId, setCheckoutOrderId] = useState(null)
  const [checkoutStatus, setCheckoutStatus] = useState(null)
  const [checkoutBusy, setCheckoutBusy] = useState(false)

  const defaultWebhook = `${String(API_ORIGIN).replace(/\/$/, '')}/api/zeno-webhook`

  const loadSettings = useCallback(async () => {
    try {
      const s = await getZenopaySettings()
      const merged = {
        ...defaultSettings(),
        ...s,
        environment: String(s?.environment || 'sandbox').toLowerCase(),
        apiEndpoint: s?.apiEndpoint ?? s?.api_endpoint ?? '',
        accountId: s?.accountId ?? s?.account_id ?? '',
        webhookUrl: s?.webhookUrl ?? s?.webhook_url ?? defaultWebhook,
        hasApiKey: Boolean(s?.hasApiKey),
        apiKeyMasked: String(s?.apiKeyMasked || '******'),
      }
      setCfg(merged)
      setDraft({ ...merged, apiKey: '' })
    } catch (e) {
      showToast('error', e?.message || 'Could not load ZenoPay settings')
    }
  }, [defaultWebhook, showToast])

  useEffect(() => {
    let cancelled = false
    const raf = requestAnimationFrame(() => {
      if (!cancelled) void loadSettings()
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
    }
  }, [loadSettings])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await getPlans()
        if (cancelled) return
        setCheckoutPlans(Array.isArray(list) ? list.filter((p) => p.isActive !== false) : [])
      } catch {
        if (!cancelled) setCheckoutPlans([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!checkoutOrderId) return
    if (checkoutStatus === 'SUCCESS' || checkoutStatus === 'FAILED') return
    let cancelled = false
    const poll = async () => {
      try {
        const r = await getPaymentStatus(checkoutOrderId)
        if (cancelled) return
        const st = String(r?.status ?? 'PENDING')
        setCheckoutStatus((prev) => {
          if (prev !== 'SUCCESS' && st === 'SUCCESS') {
            showToast(
              'success',
              'Payment confirmed. Subscription updated for that phone — consumer app can unlock channels.',
            )
          }
          if (prev !== 'FAILED' && st === 'FAILED') {
            showToast('error', 'Payment failed or was declined.')
          }
          return st
        })
      } catch {
        /* network blips: keep polling */
      }
    }
    void poll()
    const id = window.setInterval(poll, 4000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [checkoutOrderId, checkoutStatus, showToast])

  const dirty = useMemo(
    () =>
      draft.environment !== cfg.environment ||
      draft.apiEndpoint !== cfg.apiEndpoint ||
      draft.accountId !== cfg.accountId ||
      draft.webhookUrl !== cfg.webhookUrl ||
      draft.apiKey.trim() !== '',
    [draft, cfg],
  )

  function showFlash(type, message) {
    setFlash({ type, message })
    window.setTimeout(() => setFlash(null), 4000)
  }

  async function handleSave(e) {
    e.preventDefault()
    setSaving(true)
    try {
      const payload = {
        environment: draft.environment,
        apiEndpoint: draft.apiEndpoint.trim(),
        accountId: draft.accountId.trim(),
        webhookUrl: draft.webhookUrl.trim() || defaultWebhook,
      }
      if (draft.apiKey.trim()) payload.apiKey = draft.apiKey.trim()
      const saved = await putZenopaySettings(payload)
      setCfg(saved)
      setDraft((prev) => ({ ...saved, apiKey: prev.apiKey }))
      showFlash('success', 'ZenoPay settings saved.')
      showToast('success', 'ZenoPay settings saved.')
    } catch (err) {
      showToast('error', err?.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function handleCheckoutPay(e) {
    e.preventDefault()
    const pid = Number(payPlanId)
    if (!payPhone.trim() || !Number.isFinite(pid)) {
      showToast('error', 'Enter phone and choose a plan')
      return
    }
    setCheckoutBusy(true)
    try {
      const data = await postCreatePayment({ phone: payPhone.trim(), planId: pid })
      const oid = data?.orderId ?? data?.order_id
      if (!oid) {
        showToast('error', 'No order id returned from server')
        return
      }
      setCheckoutOrderId(String(oid))
      setCheckoutStatus('PENDING')
      showToast('success', 'Payment started — waiting for ZenoPay confirmation…')
    } catch (err) {
      showToast('error', err?.message || 'Payment could not be started')
    } finally {
      setCheckoutBusy(false)
    }
  }

  function clearCheckout() {
    setCheckoutOrderId(null)
    setCheckoutStatus(null)
  }

  async function handleTestConnection() {
    setTesting(true)
    try {
      const result = await postZenopayTest({})
      const ok = result?.success === true
      const msg = String(result?.message || (ok ? 'OK' : 'Failed'))
      const next = {
        ...cfg,
        lastTestAt: new Date().toISOString(),
        lastTestOk: ok,
        lastTestMessage: msg,
      }
      setCfg(next)
      setDraft((prev) => ({ ...prev, ...next }))
      showFlash(ok ? 'success' : 'error', msg)
      showToast(ok ? 'success' : 'error', msg)
    } catch (err) {
      showToast('error', err?.message || 'Test failed')
    } finally {
      setTesting(false)
    }
  }

  const connected = cfg.lastTestOk === true
  const failed = cfg.lastTestOk === false

  return (
    <>
      <Topbar />
      <main className="mt-6 flex min-h-0 flex-1 flex-col gap-6">
        {flash ? (
          <FlashMessage type={flash.type} message={flash.message} onDismiss={() => setFlash(null)} />
        ) : null}

        <header>
          <h1 className="text-2xl font-bold text-white sm:text-3xl">ZenoPay Settings</h1>
          <p className="mt-1 text-sm text-slate-400">Payment gateway configuration</p>
        </header>

        <form onSubmit={handleSave} className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <div className="space-y-5 rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6 ring-1 ring-white/[0.04]">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-400/90">
              Connection
            </h2>

            <div className="flex items-center gap-3 rounded-xl border border-slate-600/50 bg-slate-900/50 px-4 py-3">
              <Wifi className="h-5 w-5 shrink-0 text-slate-400" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold uppercase text-slate-500">Status</p>
                <p className="mt-0.5 flex items-center gap-2 text-sm font-medium">
                  {cfg.lastTestOk == null ? (
                    <span className="text-slate-400">Not tested yet</span>
                  ) : connected ? (
                    <>
                      <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                      <span className="text-emerald-300">Connected</span>
                    </>
                  ) : (
                    <>
                      <XCircle className="h-4 w-4 text-red-400" />
                      <span className="text-red-300">Failed</span>
                    </>
                  )}
                </p>
                {cfg.lastTestAt ? (
                  <p className="mt-1 text-xs text-slate-500">
                    Last check: {new Date(cfg.lastTestAt).toLocaleString()}
                  </p>
                ) : null}
                {failed && cfg.lastTestMessage ? (
                  <p className="mt-1 text-xs text-red-400/90">{cfg.lastTestMessage}</p>
                ) : null}
              </div>
            </div>

            <div>
              <label className={labelClass()} htmlFor="zp-env">
                Environment
              </label>
              <select
                id="zp-env"
                value={draft.environment}
                onChange={(e) => setDraft((d) => ({ ...d, environment: e.target.value }))}
                className={inputClass()}
              >
                <option value="live">Live</option>
                <option value="sandbox">Sandbox</option>
              </select>
            </div>

            <div>
              <label className={labelClass()} htmlFor="zp-end">
                API endpoint (ZENO_ENDPOINT)
              </label>
              <input
                id="zp-end"
                value={draft.apiEndpoint}
                onChange={(e) => setDraft((d) => ({ ...d, apiEndpoint: e.target.value }))}
                placeholder="https://api.example.com/v1"
                className={inputClass()}
              />
            </div>

            <div>
              <label className={labelClass()} htmlFor="zp-acct">
                Account ID (ZENO_ACCOUNT_ID)
              </label>
              <input
                id="zp-acct"
                value={draft.accountId}
                onChange={(e) => setDraft((d) => ({ ...d, accountId: e.target.value }))}
                placeholder="Merchant / account identifier"
                className={inputClass()}
              />
            </div>

            <button
              type="button"
              onClick={handleTestConnection}
              disabled={testing}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm font-semibold text-amber-200 transition-colors hover:bg-amber-500/20 disabled:opacity-50"
            >
              {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Test Connection
            </button>
          </div>

          <div className="space-y-5 rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6 ring-1 ring-white/[0.04]">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-400/90">
              Credentials
            </h2>

            <div>
              <label className={labelClass()} htmlFor="zp-key">
                API Key <span className="text-slate-500">(masked when saved)</span>
              </label>
              <input
                id="zp-key"
                type="password"
                autoComplete="off"
                value={draft.apiKey}
                onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
                placeholder="Enter API key"
                className={inputClass()}
              />
              <p className="mt-2 text-xs text-slate-500">
                Stored preview:{' '}
                <span className="font-mono text-slate-400">
                  {cfg.hasApiKey ? cfg.apiKeyMasked || '******' : maskKey(cfg.apiKey)}
                </span>
                {cfg.hasApiKey ? (
                  <span className="ml-2 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-300">
                    Saved
                  </span>
                ) : null}
              </p>
            </div>

            <div>
              <label className={labelClass()} htmlFor="zp-wh">
                Webhook URL
              </label>
              <input
                id="zp-wh"
                value={draft.webhookUrl}
                onChange={(e) => setDraft((d) => ({ ...d, webhookUrl: e.target.value }))}
                className={inputClass()}
              />
            </div>
          </div>

          <div className="xl:col-span-2 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setDraft({ ...cfg, apiKey: '' })}
              disabled={!dirty || saving || testing}
              className="rounded-xl border border-slate-600 px-6 py-3 text-sm font-medium text-slate-300 hover:bg-slate-800 disabled:opacity-40"
            >
              Reset
            </button>
            <button
              type="submit"
              disabled={!dirty || saving || testing}
              className="rounded-xl bg-gradient-to-r from-amber-400 to-yellow-500 px-8 py-3 text-sm font-bold text-slate-950 shadow-[0_8px_28px_rgba(251,191,36,0.35)] disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </form>

        <section className="rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6 ring-1 ring-white/[0.04]">
          <div className="flex items-start gap-3">
            <Smartphone className="mt-0.5 h-5 w-5 shrink-0 text-amber-400/90" />
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-400/90">
                Test checkout &amp; status poll
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                Starts a real collection, then polls{' '}
                <code className="rounded bg-slate-900 px-1 py-0.5 text-[11px] text-slate-300">
                  GET /api/payment-status/:order_id
                </code>{' '}
                every 4s until status is SUCCESS or FAILED (same flow a consumer app should use).
              </p>
            </div>
          </div>
          <form onSubmit={handleCheckoutPay} className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="sm:col-span-1">
              <label className={labelClass()} htmlFor="zp-pay-phone">
                Phone (customer)
              </label>
              <input
                id="zp-pay-phone"
                value={payPhone}
                onChange={(e) => setPayPhone(e.target.value)}
                placeholder="07XXXXXXXX"
                className={inputClass()}
                autoComplete="tel"
              />
            </div>
            <div className="sm:col-span-1">
              <label className={labelClass()} htmlFor="zp-pay-plan">
                Plan
              </label>
              <select
                id="zp-pay-plan"
                value={payPlanId}
                onChange={(e) => setPayPlanId(e.target.value)}
                className={inputClass()}
              >
                <option value="">— Select plan —</option>
                {checkoutPlans.map((p) => (
                  <option key={p.id} value={String(p.id)}>
                    {p.name} — {p.price != null ? `${p.price} TZS` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col justify-end gap-2 sm:col-span-2 lg:col-span-1">
              <button
                type="submit"
                disabled={checkoutBusy}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm font-semibold text-emerald-200 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
              >
                {checkoutBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Pay with ZenoPay
              </button>
            </div>
          </form>
          {checkoutOrderId ? (
            <div className="mt-4 rounded-xl border border-slate-600/50 bg-slate-900/40 px-4 py-3 text-sm text-slate-300">
              <p className="font-mono text-xs text-slate-400">order_id: {checkoutOrderId}</p>
              <p className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-slate-500">Status:</span>
                {checkoutStatus === 'PENDING' || checkoutStatus == null ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin text-amber-400" />
                    <span className="text-amber-200">Waiting for confirmation…</span>
                  </>
                ) : checkoutStatus === 'SUCCESS' ? (
                  <span className="font-medium text-emerald-300">SUCCESS — done</span>
                ) : checkoutStatus === 'FAILED' ? (
                  <span className="font-medium text-red-300">FAILED</span>
                ) : (
                  <span>{checkoutStatus}</span>
                )}
              </p>
              <button
                type="button"
                onClick={clearCheckout}
                className="mt-3 text-xs font-medium text-slate-500 underline hover:text-slate-300"
              >
                Clear session
              </button>
            </div>
          ) : null}
        </section>
      </main>
    </>
  )
}

export default ZenoPayPage
