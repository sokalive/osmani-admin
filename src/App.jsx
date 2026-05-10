import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import ProtectedAppShell from './components/ProtectedAppShell'
import AdminLayout from './components/AdminLayout'
import { DashboardRoutes } from './adminDashboardRoutes.jsx'
import AdminLoginPage from './pages/AdminLoginPage'
import AdminOtpPage from './pages/AdminOtpPage'
import { AdminAuthProvider, useAdminAuth } from './context/AdminAuthContext.jsx'

function AuthAwareRoutes() {
  const { ready, panelAuthRequired } = useAdminAuth()
  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0B0F1A] text-slate-400">
        Inapakia…
      </div>
    )
  }
  if (!panelAuthRequired) {
    return (
      <AdminLayout>
        <Routes>
          <DashboardRoutes />
        </Routes>
      </AdminLayout>
    )
  }
  return (
    <Routes>
      <Route path="/login" element={<AdminLoginPage />} />
      <Route path="/login/otp" element={<AdminOtpPage />} />
      <Route element={<ProtectedAppShell />}>
        <DashboardRoutes />
      </Route>
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
