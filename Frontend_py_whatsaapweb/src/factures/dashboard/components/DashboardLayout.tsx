import React from 'react';
import { Outlet } from 'react-router-dom';
import DashboardSidebar from './DashboardSidebar';
import DashboardTopbar from './DashboardTopbar';

export default function DashboardLayout() {
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(() => localStorage.getItem('adminSidebarCollapsed') === 'true');

  React.useEffect(() => {
    try { window.name = 'w_dashboard'; } catch (e) { /* ignore */ }
    return () => {
      try { if (window.name === 'w_dashboard') window.name = ''; } catch(e) {}
    };
  }, []);

  const toggleSidebar = () => {
    setSidebarCollapsed((current) => {
      const next = !current;
      localStorage.setItem('adminSidebarCollapsed', String(next));
      return next;
    });
  };

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Sidebar */}
      <DashboardSidebar collapsed={sidebarCollapsed} onToggleCollapsed={toggleSidebar} />
      
      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Topbar */}
        <DashboardTopbar />
        
        {/* Content Area */}
        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
