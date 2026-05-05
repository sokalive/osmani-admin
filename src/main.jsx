import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DeviceSubscriptionProvider } from './context/DeviceSubscriptionContext.jsx'
import { ToastProvider } from './context/ToastContext.jsx'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ToastProvider>
      <DeviceSubscriptionProvider>
        <App />
      </DeviceSubscriptionProvider>
    </ToastProvider>
  </StrictMode>,
)
