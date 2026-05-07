import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import AnalyticsPage from './pages/AnalyticsPage'
import AppUpdatePage from './pages/AppUpdatePage'
import BannersPage from './pages/BannersPage'
import ChannelsPage from './pages/ChannelsPage'
import DashboardPage from './pages/DashboardPage'
import DeviceControlPage from './pages/DeviceControlPage'
import NotificationsPage from './pages/NotificationsPage'
import PaymentProvidersPage from './pages/PaymentProvidersPage'
import PlansPage from './pages/PlansPage'
import PopupSettingsPage from './pages/PopupSettingsPage'
import SecurityAlertsPage from './pages/SecurityAlertsPage'
import SecurityLogsPage from './pages/SecurityLogsPage'
import ServerHealthPage from './pages/ServerHealthPage'
import TransferCodesPage from './pages/TransferCodesPage'
import TransactionsPage from './pages/TransactionsPage'
import UsersPage from './pages/UsersPage'
import WhatsAppPage from './pages/WhatsAppPage'
import ZenoPayPage from './pages/ZenoPayPage'

function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-[#0B0F1A] text-slate-100">
        <Sidebar />
        <div className="ml-[280px] flex min-h-screen flex-col">
          <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col p-6">
            <Routes>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/channels" element={<ChannelsPage />} />
              <Route path="/banners" element={<BannersPage />} />
              <Route path="/plans" element={<PlansPage />} />
              <Route path="/transactions" element={<TransactionsPage />} />
              <Route path="/users" element={<UsersPage />} />
              <Route path="/notifications" element={<NotificationsPage />} />
              <Route path="/payment-providers" element={<PaymentProvidersPage />} />
              <Route path="/analytics" element={<AnalyticsPage />} />
              <Route path="/zenopay" element={<ZenoPayPage />} />
              <Route path="/whatsapp" element={<WhatsAppPage />} />
              <Route path="/app-update" element={<AppUpdatePage />} />
              <Route path="/server-health" element={<ServerHealthPage />} />
              <Route path="/popup-settings" element={<PopupSettingsPage />} />
              <Route path="/device-control" element={<DeviceControlPage />} />
              <Route path="/security-alerts" element={<SecurityAlertsPage />} />
              <Route path="/security-logs" element={<SecurityLogsPage />} />
              <Route path="/transfer-codes" element={<TransferCodesPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
        </div>
      </div>
    </BrowserRouter>
  )
}

export default App
