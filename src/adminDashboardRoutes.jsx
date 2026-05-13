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
import SonicPesaSettingsPage from './pages/SonicPesaSettingsPage'

/**
 * Route elements for use under a pathless layout route (`<Route element={…}>`).
 * Must be direct children of `<Routes>` (as an array); do not wrap in a component
 * or Fragment — React Router will not register nested `<Route>` in that case.
 */
export const dashboardRouteElements = [
  <Route key="home" index element={<DashboardPage />} />,
  <Route key="channels" path="channels" element={<ChannelsPage />} />,
  <Route key="banners" path="banners" element={<BannersPage />} />,
  <Route key="plans" path="plans" element={<PlansPage />} />,
  <Route key="transactions" path="transactions" element={<TransactionsPage />} />,
  <Route key="users" path="users" element={<UsersPage />} />,
  <Route key="notifications" path="notifications" element={<NotificationsPage />} />,
  <Route
    key="payment-providers"
    path="payment-providers"
    element={<PaymentProvidersPage />}
  />,
  <Route key="analytics" path="analytics" element={<AnalyticsPage />} />,
  <Route key="zenopay" path="zenopay" element={<ZenoPayPage />} />,
  <Route key="sonicpesa" path="sonicpesa" element={<SonicPesaSettingsPage />} />,
  <Route key="whatsapp" path="whatsapp" element={<WhatsAppPage />} />,
  <Route key="app-update" path="app-update" element={<AppUpdatePage />} />,
  <Route key="server-health" path="server-health" element={<ServerHealthPage />} />,
  <Route key="popup-settings" path="popup-settings" element={<PopupSettingsPage />} />,
  <Route key="device-control" path="device-control" element={<DeviceControlPage />} />,
  <Route key="security-alerts" path="security-alerts" element={<SecurityAlertsPage />} />,
  <Route key="security-logs" path="security-logs" element={<SecurityLogsPage />} />,
  <Route key="transfer-codes" path="transfer-codes" element={<TransferCodesPage />} />,
  <Route key="manual-subscription" path="manual-subscription" element={<ManualSubscriptionPage />} />,
  <Route key="admin-security" path="admin-security" element={<AdminSecurityPage />} />,
  <Route key="fallback" path="*" element={<Navigate to="/" replace />} />,
]
