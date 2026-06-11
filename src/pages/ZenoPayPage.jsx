import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, Loader2, Smartphone, Wifi, XCircle } from 'lucide-react'
import FlashMessage from '../components/FlashMessage'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import { useDeviceSubscription } from '../context/DeviceSubscriptionContext.jsx'
import {
  API_ORIGIN,
  getCheckoutPaymentProviders,
  getPaymentStatus,
  getPlans,
  getZenopaySettings,
  postCreatePayment,
  postAdminAuraxpayTestCreateOrder,
  postSonicpesaCreateOrder,
  postZenopayTest,
  syncStreamUrl,
  putZenopaySettings,
} from '../lib/api'
import { formatAdminDateTime } from '../lib/formatAdminDateTime'

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
    envOverrideAny: false,
    envOverrideActive: null,
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
  const {
    subscriptionState,
    appModes,
    clearSubscription,
    trackSubscriptionDevice,
  } = useDeviceSubscription()
  const [cfg, setCfg] = useState(() => defaultSettings())
  const [draft, setDraft] = useState(() => ({ ...defaultSettings() }))
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [flash, setFlash] = useState(null)

  const [checkoutPlans, setCheckoutPlans] = useState([])
  const [checkoutAvail, setCheckoutAvail] = useState({ zenopay: false, sonicpesa: false, auraxpay: false })
  const [payProvider, setPayProvider] = useState('zenopay')
  const [payPhone, setPayPhone] = useState('')
  const [payDeviceId, setPayDeviceId] = useState('')
  const [payPlanId, setPayPlanId] = useState('')
  const [checkoutOrderId, setCheckoutOrderId] = useState(null)
  const [checkoutStatus, setCheckoutStatus] = useState('IDLE')
  const [paymentWaitOpen, setPaymentWaitOpen] = useState(false)
  const [checkoutBusy, setCheckoutBusy] = useState(false)
  const unlockHandledRef = useRef(false)
  const blockedNoticeRef = useRef('')

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
        envOverrideAny: Boolean(s?.envOverrideAny),
        envOverrideActive: s?.envOverrideActive ?? null,
      }
      setCfg(merged)
      setDraft({ ...merged, apiKey: '' })
    } catch (e) {
      showToast('error', e?.message || 'Could not load ZenoPay settings')
    }
  }, [defaultWebhook, showToast])

  const loadCheckoutProviders = useCallback(async () => {
    try {
      const r = await getCheckoutPaymentProviders()
      const auraxForTest = r?.auraxpay === true || r?.auraxpay_test === true
      setCheckoutAvail({
        zenopay: r?.zenopay === true,
        sonicpesa: r?.sonicpesa === true,
        auraxpay: auraxForTest,
      })
      if (import.meta.env.DEV) {
        console.info('[test-checkout] providers', {
          zenopay: r?.zenopay === true,
          sonicpesa: r?.sonicpesa === true,
          auraxpay: r?.auraxpay === true,
          auraxpay_test: r?.auraxpay_test === true,
          auraxForTest,
        })
      }
    } catch {
      setCheckoutAvail({ zenopay: false, sonicpesa: false, auraxpay: false })
    }
  }, [])

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
    const raf = requestAnimationFrame(() => {
      if (!cancelled) void loadCheckoutProviders()
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
    }
  }, [loadCheckoutProviders])

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
    if (payProvider === 'sonicpesa' && !checkoutAvail.sonicpesa) {
      setPayProvider(checkoutAvail.auraxpay ? 'auraxpay' : 'zenopay')
    }
    if (payProvider === 'auraxpay' && !checkoutAvail.auraxpay) {
      setPayProvider(checkoutAvail.sonicpesa ? 'sonicpesa' : 'zenopay')
    }
    if (payProvider === 'zenopay' && !checkoutAvail.zenopay) {
      if (checkoutAvail.sonicpesa) setPayProvider('sonicpesa')
      else if (checkoutAvail.auraxpay) setPayProvider('auraxpay')
    }
  }, [checkoutAvail.zenopay, checkoutAvail.sonicpesa, checkoutAvail.auraxpay, payProvider])

  useEffect(() => {
    const es = new EventSource(syncStreamUrl(['analytics', 'config']))
    const onConfigRefresh = () => {
      void loadSettings()
      void loadCheckoutProviders()
    }
    const onTransactionUpdate = (event) => {
      if (!checkoutOrderId) return
      try {
        const packet = JSON.parse(event.data)
        const orderId = String(packet?.payload?.orderId ?? packet?.payload?.order_id ?? '').trim()
        if (orderId && orderId === String(checkoutOrderId)) {
          void (async () => {
            try {
              const out = await getPaymentStatus(checkoutOrderId)
              const next = String(out?.status || 'PENDING').toUpperCase()
              setCheckoutStatus(next)
            } catch {
              // ignore event-driven refresh failures; interval fallback covers this
            }
          })()
        }
      } catch {
        // ignore malformed event payloads
      }
    }
    es.addEventListener('config.zenopay_settings_changed', onConfigRefresh)
    es.addEventListener('config.sonicpesa_settings_changed', onConfigRefresh)
    es.addEventListener('config.auraxpay_settings_changed', onConfigRefresh)
    es.addEventListener('analytics.transaction_updated', onTransactionUpdate)
    return () => es.close()
  }, [checkoutOrderId, loadSettings, loadCheckoutProviders])

  useEffect(() => {
    unlockHandledRef.current = false
    blockedNoticeRef.current = ''
    setCheckoutStatus(checkoutOrderId ? 'PENDING' : 'IDLE')
  }, [checkoutOrderId, payDeviceId])

  useEffect(() => {
    if (!paymentWaitOpen || !checkoutOrderId) return
    let cancelled = false
    const poll = async () => {
      try {
        const out = await getPaymentStatus(checkoutOrderId)
        if (cancelled) return
        const next = String(out?.status || 'PENDING').toUpperCase()
        setCheckoutStatus(next)
        if (next === 'FAILED') {
          setPaymentWaitOpen(false)
          showToast('error', 'Payment failed or was not completed.')
        }
      } catch {
        // Keep modal alive; subscription verify + next poll can still recover.
      }
    }
    void poll()
    const id = window.setInterval(() => {
      void poll()
    }, 3000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [paymentWaitOpen, checkoutOrderId, showToast])

  useEffect(() => {
    if (!checkoutOrderId || !payDeviceId.trim()) return
    trackSubscriptionDevice({
      deviceId: payDeviceId.trim(),
      orderId: checkoutOrderId,
    })
  }, [checkoutOrderId, payDeviceId, trackSubscriptionDevice])

  useEffect(() => {
    if (!paymentWaitOpen) return
    if (subscriptionState.blocked === true) {
      const msg = subscriptionState.blockReason || 'Device blocked'
      if (msg !== blockedNoticeRef.current) {
        blockedNoticeRef.current = msg
        showToast('error', `Playback blocked: ${msg}`)
      }
    }
    const active = subscriptionState.active === true || subscriptionState.isActive === true
    if (active && !unlockHandledRef.current) {
      unlockHandledRef.current = true
      setPaymentWaitOpen(false)
      showToast('success', 'Device subscription active — channels unlocked.')
    }
  }, [paymentWaitOpen, showToast, subscriptionState])

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
    const dev = payDeviceId.trim()
    if (!payPhone.trim() || !Number.isFinite(pid)) {
      showToast('error', 'Enter phone and choose a plan')
      return
    }
    if (!dev) {
      showToast('error', 'Enter device ID (matches client device_subscriptions)')
      return
    }
    if (!checkoutAvail.zenopay && !checkoutAvail.sonicpesa && !checkoutAvail.auraxpay) {
      showToast('error', 'No payment providers are configured')
      return
    }
    if (payProvider === 'zenopay' && !checkoutAvail.zenopay) {
      showToast('error', 'ZenoPay is not available')
      return
    }
    if (payProvider === 'sonicpesa' && !checkoutAvail.sonicpesa) {
      showToast('error', 'SonicPesa is disabled or not configured')
      return
    }
    if (payProvider === 'auraxpay' && !checkoutAvail.auraxpay) {
      showToast('error', 'Aurax Pay is disabled or not configured')
      return
    }
    setCheckoutBusy(true)
    try {
      const orderBody = {
        phone: payPhone.trim(),
        planId: pid,
        deviceId: dev,
      }
      if (import.meta.env.DEV) {
        console.info('[test-checkout] initiating payment', { provider: payProvider, ...orderBody })
      }
      const data =
        payProvider === 'sonicpesa'
          ? await postSonicpesaCreateOrder(orderBody)
          : payProvider === 'auraxpay'
            ? await postAdminAuraxpayTestCreateOrder(orderBody)
            : await postCreatePayment(orderBody)
      const oid = data?.orderId ?? data?.order_id
      if (!oid) {
        showToast('error', 'No order id returned from server')
        return
      }
      setCheckoutOrderId(String(oid))
      setCheckoutStatus('PENDING')
      setPaymentWaitOpen(true)
      showToast('success', 'Complete payment on phone — unlocking via realtime stream + poll.')
    } catch (err) {
      const providerDetail =
        err?.body?.providerMessage ||
        (err?.body?.providerError && typeof err.body.providerError === 'object'
          ? err.body.providerError.message || err.body.providerError.error
          : null) ||
        (err?.body?.details && typeof err.body.details === 'object'
          ? err.body.details.message || err.body.details.error
          : null)
      if (import.meta.env.DEV && err?.body) {
        console.warn('[test-checkout] payment failed', err.body)
      }
      showToast('error', providerDetail || err?.message || 'Payment could not be started')
    } finally {
      setCheckoutBusy(false)
    }
  }

  function clearCheckout() {
    setCheckoutOrderId(null)
    setCheckoutStatus('IDLE')
    setPaymentWaitOpen(false)
    clearSubscription()
  }

  function handleEndeleaContinue() {
    setPaymentWaitOpen(false)
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
  const runtimeStateLabel =
    subscriptionState.status != null ? subscriptionState.status : subscriptionState.isActive ? 'active' : 'unknown'
  const modeLabels = [
    appModes.free_mode ? 'FREE' : null,
    appModes.emergency_mode ? 'EMERGENCY' : null,
    appModes.maintenance_mode ? 'MAINTENANCE' : null,
  ].filter(Boolean)

  return (
    <>
      <Topbar />
      <main className="mt-6 flex min-h-0 flex-1 flex-col gap-6">
        {flash ? (
          <FlashMessage type={flash.type} message={flash.message} onDismiss={() => setFlash(null)} />
        ) : null}

        {cfg.envOverrideAny ? (
          <div
            className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-4 py-3 text-sm text-amber-100"
            role="status"
          >
            <p className="font-semibold text-amber-200">Mazingira ya Render (ZENO_*) yanatumika</p>
            <p className="mt-1 text-amber-100/90">
              Fomu inaonyesha maadili yaliyohifadhiwa kwenye PostgreSQL. Ombi la malipo la kweli linaweza kutumia
              api endpoint / account / key kutoka .env ikiwa imewekwa — ndiyo maana huwezi kuona mabadiliko ya fomu
              kama yanavyotumika kwenye simu.
            </p>
          </div>
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
                Test checkout · device subscription (realtime + poll)
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                Requires <code className="font-mono text-slate-400">deviceId</code>. Choose ZenoPay, SonicPesa, or
                Aurax Pay (Aurax appears when configured in Aurax Pay Settings — production Enable not required for
                admin test). After the provider webhook,
                runtime parity uses canonical{' '}
                <code className="rounded bg-slate-900 px-1 py-0.5 text-[11px] text-slate-300">
                  /api/subscription/verify
                </code>{' '}
                for state snapshots, with{' '}
                <code className="rounded bg-slate-900 px-1 py-0.5 text-[11px] text-slate-300">
                  /api/subscription-stream
                </code>{' '}
                as the realtime trigger and{' '}
                <code className="rounded bg-slate-900 px-1 py-0.5 text-[11px] text-slate-300">
                  /api/subscription-status?device_id=
                </code>{' '}
                as fallback compatibility polling every 3s.
              </p>
            </div>
          </div>
          <form onSubmit={handleCheckoutPay} className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[checkoutAvail.zenopay, checkoutAvail.sonicpesa, checkoutAvail.auraxpay].filter(Boolean).length >
            1 ? (
              <div className="sm:col-span-2 lg:col-span-4">
                <p className={labelClass()}>Select payment method</p>
                <div className="mt-2 flex flex-wrap gap-6">
                  {checkoutAvail.zenopay ? (
                    <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-200">
                      <input
                        type="radio"
                        name="checkoutPayProvider"
                        className="h-4 w-4 border-slate-500 text-amber-500 focus:ring-amber-500/40"
                        checked={payProvider === 'zenopay'}
                        onChange={() => setPayProvider('zenopay')}
                      />
                      ZenoPay
                    </label>
                  ) : null}
                  {checkoutAvail.sonicpesa ? (
                    <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-200">
                      <input
                        type="radio"
                        name="checkoutPayProvider"
                        className="h-4 w-4 border-slate-500 text-amber-500 focus:ring-amber-500/40"
                        checked={payProvider === 'sonicpesa'}
                        onChange={() => setPayProvider('sonicpesa')}
                      />
                      SonicPesa
                    </label>
                  ) : null}
                  {checkoutAvail.auraxpay ? (
                    <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-200">
                      <input
                        type="radio"
                        name="checkoutPayProvider"
                        className="h-4 w-4 border-slate-500 text-amber-500 focus:ring-amber-500/40"
                        checked={payProvider === 'auraxpay'}
                        onChange={() => setPayProvider('auraxpay')}
                      />
                      Aurax Pay
                    </label>
                  ) : null}
                </div>
              </div>
            ) : null}
            <div className="sm:col-span-1">
              <label className={labelClass()} htmlFor="zp-pay-device">
                Device ID
              </label>
              <input
                id="zp-pay-device"
                value={payDeviceId}
                onChange={(e) => setPayDeviceId(e.target.value)}
                placeholder="client-stable-device-id"
                className={inputClass()}
                autoComplete="off"
              />
            </div>
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
                disabled={
                  checkoutBusy ||
                  (!checkoutAvail.zenopay && !checkoutAvail.sonicpesa && !checkoutAvail.auraxpay) ||
                  (payProvider === 'zenopay' && !checkoutAvail.zenopay) ||
                  (payProvider === 'sonicpesa' && !checkoutAvail.sonicpesa) ||
                  (payProvider === 'auraxpay' && !checkoutAvail.auraxpay)
                }
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm font-semibold text-emerald-200 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
              >
                {checkoutBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Pay with{' '}
                {payProvider === 'sonicpesa'
                  ? 'SonicPesa'
                  : payProvider === 'auraxpay'
                    ? 'Aurax Pay'
                    : 'ZenoPay'}
              </button>
            </div>
          </form>
          {checkoutOrderId ? (
            <div className="mt-4 rounded-xl border border-slate-600/50 bg-slate-900/40 px-4 py-3 text-sm text-slate-300">
              <p className="font-mono text-xs text-slate-400">order_id: {checkoutOrderId}</p>
              <p className="mt-1 font-mono text-xs text-slate-400">device_id: {payDeviceId}</p>
              <p className="mt-1 font-mono text-xs text-slate-400">payment_status: {checkoutStatus}</p>
              <p className="mt-2 text-xs text-slate-500">
                Open the modal after pay — realtime + 3s poll until active. ENDELEA only closes the modal (no
                API).
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

        {paymentWaitOpen ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
            <div className="w-full max-w-md rounded-2xl border border-slate-600 bg-slate-950 p-6 shadow-2xl ring-1 ring-white/10">
              <h3 className="text-lg font-semibold text-white">Waiting for unlock</h3>
              <p className="mt-2 font-mono text-xs text-slate-500">{checkoutOrderId}</p>
              <p className="mt-4 flex items-center gap-2 text-sm text-amber-200">
                <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                Canonical verify refresh + realtime SSE + fallback polling…
              </p>
              <div className="mt-4 space-y-2 rounded-xl border border-slate-700/70 bg-slate-900/60 px-4 py-3 text-xs text-slate-300">
                <p>
                  Payment status: <span className="font-semibold text-white">{checkoutStatus}</span>
                </p>
                <p>
                  Status: <span className="font-semibold text-white">{runtimeStateLabel}</span>
                </p>
                <p>
                  Playback allowed:{' '}
                  <span className="font-semibold text-white">
                    {subscriptionState.playbackAllowed ? 'yes' : 'no'}
                  </span>
                </p>
                {subscriptionState.playbackGateReason ? (
                  <p>
                    Gate reason:{' '}
                    <span className="font-semibold text-white">{subscriptionState.playbackGateReason}</span>
                  </p>
                ) : null}
                <p>
                  Expires:{' '}
                  <span className="font-semibold text-white">
                    {subscriptionState.expiresAt
                      ? formatAdminDateTime(subscriptionState.expiresAt)
                      : '—'}
                  </span>
                </p>
                <p>
                  Modes:{' '}
                  <span className="font-semibold text-white">
                    {modeLabels.length > 0 ? modeLabels.join(', ') : 'NORMAL'}
                  </span>
                </p>
                {subscriptionState.blocked ? (
                  <p className="text-red-300">
                    Block reason: {subscriptionState.blockReason || 'Device blocked'}
                  </p>
                ) : null}
                {subscriptionState.manualGift?.showPopup ? (
                  <p className="text-emerald-300">
                    Manual gift pending: {subscriptionState.manualGift.title || 'Gift available'}
                  </p>
                ) : null}
                {!subscriptionState.isActive && subscriptionState.plans.length > 0 ? (
                  <p className="text-slate-400">
                    Plans returned by verify: {subscriptionState.plans.length}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                className="mt-6 w-full rounded-xl border border-slate-600 py-3 text-sm font-semibold text-slate-200 hover:bg-slate-800"
                onClick={handleEndeleaContinue}
              >
                ENDELEA — close only
              </button>
              <p className="mt-3 text-center text-[11px] text-slate-500">
                Unlock state is driven by webhook → DB → verify snapshot. Stream events trigger backend refresh;
                fallback polling keeps reconnect behavior stable.
              </p>
            </div>
          </div>
        ) : null}
      </main>
    </>
  )
}

export default ZenoPayPage
