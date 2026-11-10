import { Suspense, useRef, useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import DashboardSidebar from './DashboardSidebar';
import DashboardTopbar from './DashboardTopbar';
import { logoutSession } from '../../auth/services/authService';
import { useUserRoleJotai } from '../../../jotai/middleware/useUserRoleJotai';

export default function DashboardLayout() {
  const navigate = useNavigate();
  const { userRole } = useUserRoleJotai();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => (
    localStorage.getItem('adminSidebarCollapsed') === 'true'
  ));
  const [mobileOpen, setMobileOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const pageTitle = useRef<HTMLHeadingElement>(null);
  const isAdmin = userRole === 'ADMIN';

  function toggleSidebar() {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    localStorage.setItem('adminSidebarCollapsed', String(next));
  }

  function handleNavigate() {
    if (!mobileOpen) return;
    setMobileOpen(false);
    pageTitle.current?.focus();
  }

  async function handleLogout() {
    if (await logoutSession()) navigate('/auth/login', { replace: true });
  }

  return (
    <div
      className="grid h-[100dvh] grid-cols-[minmax(0,1fr)] grid-rows-[auto_auto_minmax(0,1fr)]
        overflow-hidden bg-canvas text-primary lg:grid-cols-[auto_minmax(0,1fr)]"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !mobileOpen) return;
        setMobileOpen(false);
        menuButton.current?.focus();
      }}
    >
      <a
        href="#workspace-content"
        className="sr-only z-50 rounded-lg bg-surface p-3 focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        Ir al contenido
      </a>
      <DashboardTopbar
        isAdmin={isAdmin}
        mobileOpen={mobileOpen}
        onToggleMenu={() => setMobileOpen((open) => !open)}
        menuButtonRef={menuButton}
        titleRef={pageTitle}
      />
      <DashboardSidebar
        isAdmin={isAdmin}
        collapsed={sidebarCollapsed}
        mobileOpen={mobileOpen}
        onToggleCollapsed={toggleSidebar}
        onNavigate={handleNavigate}
        onLogout={() => void handleLogout()}
      />
      <main
        id="workspace-content"
        tabIndex={-1}
        className="col-start-1 row-start-3 min-h-0 min-w-0 overflow-auto lg:col-start-2"
      >
        <Suspense fallback={<p role="status" className="p-4 text-sm text-secondary">Cargando vista…</p>}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
