import { Navigate, Route } from 'react-router-dom'
import AnalyticsPage from './pages/AnalyticsPage'
import AdminSecurityPage from './pages/AdminSecurityPage'
import AppUpdatePage from './pages/AppUpdatePage'
import BannersPage from './pages/BannersPage'
import ChannelsPage from './pages/ChannelsPage'
import DashboardPage from './pages/DashboardPage'
import DeviceControlPage from './pages/DeviceControlPage'
import TrialWatchPage from './pages/TrialWatchPage'
import NotificationsPage from './pages/NotificationsPage'
import SmsCenterPage from './pages/SmsCenterPage'
import PaymentProvidersPage from './pages/PaymentProvidersPage'
import PlansPage from './pages/PlansPage'
import PopupSettingsPage from './pages/PopupSettingsPage'
import SecurityDashboardPage from './pages/SecurityDashboardPage'
import SecurityRiskDeviceInvestigationPage from './pages/SecurityRiskDeviceInvestigationPage'
import ServerHealthPage from './pages/ServerHealthPage'
import TransferCodesPage from './pages/TransferCodesPage'
import ManualSubscriptionPage from './pages/ManualSubscriptionPage'
import TransactionsPage from './pages/TransactionsPage'
import CustomerInvestigationPage from './pages/CustomerInvestigationPage'
import UsersPage from './pages/UsersPage'
import UsersIntelligencePage from './pages/UsersIntelligencePage'
import UsersIntelligenceDetailPage from './pages/UsersIntelligenceDetailPage'
import DeviceRegistryPage from './pages/DeviceRegistryPage'
import WhatsAppPage from './pages/WhatsAppPage'
import ZenoPayPage from './pages/ZenoPayPage'
import SonicPesaSettingsPage from './pages/SonicPesaSettingsPage'
import AuraxPaySettingsPage from './pages/AuraxPaySettingsPage'
import PaymentOrdersPage from './pages/PaymentOrdersPage'
import SubscriptionRequestsPage from './pages/SubscriptionRequestsPage'

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
  <Route key="payment-orders" path="payment-orders" element={<PaymentOrdersPage />} />,
  <Route key="subscription-requests" path="subscription-requests" element={<SubscriptionRequestsPage />} />,
  <Route key="users" path="users" element={<UsersPage />} />,
  <Route key="customer-investigation" path="customer-investigation" element={<CustomerInvestigationPage />} />,
  <Route key="users-intelligence" path="users-intelligence" element={<UsersIntelligencePage />} />,
  <Route
    key="users-intelligence-detail"
    path="users-intelligence/:id"
    element={<UsersIntelligenceDetailPage />}
  />,
  <Route key="device-registry" path="device-registry" element={<DeviceRegistryPage />} />,
  <Route key="notifications" path="notifications" element={<NotificationsPage />} />,
  <Route key="sms-center" path="sms-center" element={<SmsCenterPage />} />,
  <Route
    key="payment-providers"
    path="payment-providers"
    element={<PaymentProvidersPage />}
  />,
  <Route key="analytics" path="analytics" element={<AnalyticsPage />} />,
  <Route key="zenopay" path="zenopay" element={<ZenoPayPage />} />,
  <Route key="sonicpesa" path="sonicpesa" element={<SonicPesaSettingsPage />} />,
  <Route key="auraxpay" path="auraxpay" element={<AuraxPaySettingsPage />} />,
  <Route key="whatsapp" path="whatsapp" element={<WhatsAppPage />} />,
  <Route key="app-update" path="app-update" element={<AppUpdatePage />} />,
  <Route key="server-health" path="server-health" element={<ServerHealthPage />} />,
  <Route key="popup-settings" path="popup-settings" element={<PopupSettingsPage />} />,
  <Route key="device-control" path="device-control" element={<DeviceControlPage />} />,
  <Route key="trial-watch" path="trial-watch" element={<TrialWatchPage />} />,
  <Route key="security" path="security" element={<SecurityDashboardPage />} />,
  <Route
    key="security-alerts"
    path="security-alerts"
    element={<Navigate to="/security?tab=alerts" replace />}
  />,
  <Route
    key="security-risk"
    path="security-risk"
    element={<Navigate to="/security?tab=risk" replace />}
  />,
  <Route
    key="security-risk-investigation"
    path="security-risk/:deviceId/investigation"
    element={<SecurityRiskDeviceInvestigationPage />}
  />,
  <Route
    key="security-logs"
    path="security-logs"
    element={<Navigate to="/security?tab=logs" replace />}
  />,
  <Route key="transfer-codes" path="transfer-codes" element={<TransferCodesPage />} />,
  <Route key="manual-subscription" path="manual-subscription" element={<ManualSubscriptionPage />} />,
  <Route key="admin-security" path="admin-security" element={<AdminSecurityPage />} />,
  <Route key="fallback" path="*" element={<Navigate to="/" replace />} />,
]
