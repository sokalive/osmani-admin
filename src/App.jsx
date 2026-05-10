import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom'
import AdminLayout from './components/AdminLayout'
import ProtectedAppShell from './components/ProtectedAppShell'
import { dashboardRouteElements } from './adminDashboardRoutes.jsx'
import AdminLoginPage from './pages/AdminLoginPage'
import AdminOtpPage from './pages/AdminOtpPage'
import { AdminAuthProvider, useAdminAuth } from './context/AdminAuthContext.jsx'

/** Layout shell for dashboard when panel login is disabled (Bearer flow off). */
function AdminShell() {
  return (
    <AdminLayout>
      <Outlet />
    </AdminLayout>
  )
}

function AuthAwareRoutes() {
  const { ready, panelAuthRequired } = useAdminAuth()
  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0B0F1A] text-slate-400">
        Inapakia…
      </div>
    )
  }

  const shellEl = panelAuthRequired ? <ProtectedAppShell /> : <AdminShell />

  return (
    <Routes>
      {panelAuthRequired && (
        <Route path="/login" element={<AdminLoginPage />} />
      )}
      {panelAuthRequired && (
        <Route path="/login/otp" element={<AdminOtpPage />} />
      )}
      {!panelAuthRequired && (
        <Route path="/login" element={<Navigate to="/" replace />} />
      )}
      {!panelAuthRequired && (
        <Route path="/login/otp" element={<Navigate to="/" replace />} />
      )}
      <Route element={shellEl}>{dashboardRouteElements}</Route>
    </Routes>
  )
}

function App() {
  return (
    <BrowserRouter>
      <AdminAuthProvider>
        <AuthAwareRoutes />
      </AdminAuthProvider>
    </BrowserRouter>
  )
}

export default App
