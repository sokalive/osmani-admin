import { Navigate, Route } from 'react-router-dom'
import AnalyticsPage from './pages/AnalyticsPage'
import AdminSecurityPage from './pages/AdminSecurityPage'
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
import ManualSubscriptionPage from './pages/ManualSubscriptionPage'
import TransactionsPage from './pages/TransactionsPage'
import UsersPage from './pages/UsersPage'
import WhatsAppPage from './pages/WhatsAppPage'
import ZenoPayPage from './pages/ZenoPayPage'

/** Shared dashboard routes (wrapped by layout + guards in App.jsx). */
export function DashboardRoutes() {
  return (
    <>
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
      <Route path="/manual-subscription" element={<ManualSubscriptionPage />} />
      <Route path="/admin-security" element={<AdminSecurityPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </>
  )
}
