import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DeviceSubscriptionProvider } from './context/DeviceSubscriptionContext.jsx'
import { ToastProvider } from './context/ToastContext.jsx'
import './index.css'
import App from './App.jsx'

// Temporary deploy visibility (also survives aggressive minify — inspect globalThis.__OSMANI_ADMIN_BUILD__).
globalThis.__OSMANI_ADMIN_BUILD__ = {
  commit: __ADMIN_BUILD_COMMIT__,
  builtAt: __ADMIN_BUILD_TIME__,
  viteMode: __ADMIN_BUILD_VITE_MODE__,
  env: import.meta.env.MODE,
  prod: import.meta.env.PROD,
}
if (import.meta.env.PROD) {
  console.info('[osmani-admin] build', globalThis.__OSMANI_ADMIN_BUILD__)
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ToastProvider>
      <DeviceSubscriptionProvider>
        <App />
      </DeviceSubscriptionProvider>
    </ToastProvider>
  </StrictMode>,
)
