import { Navigate, Outlet, useLocation } from 'react-router-dom'
import AdminLayout from './AdminLayout'
import { useAdminAuth } from '../context/AdminAuthContext.jsx'

export default function ProtectedAppShell() {
  const { ready, sessionChecked, panelAuthRequired, token } = useAdminAuth()
  const location = useLocation()

  if (!ready || !sessionChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0B0F1A] text-slate-400">
        Inapakia…
      </div>
    )
  }

  if (panelAuthRequired && !token) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  return (
    <AdminLayout>
      <Outlet />
    </AdminLayout>
  )
}
