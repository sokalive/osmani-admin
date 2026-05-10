import Sidebar from './Sidebar'

export default function AdminLayout({ children }) {
  return (
    <div className="min-h-screen bg-[#0B0F1A] text-slate-100">
      <Sidebar />
      <div className="ml-[280px] flex min-h-screen flex-col">
        <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col p-6">{children}</div>
      </div>
    </div>
  )
}
