
import React, { useState } from 'react';
import Sidebar from './setting/components/Sidebar';
import type { MenuItem } from './setting/components/Sidebar';
import { useLocation, useNavigate, Outlet } from 'react-router-dom';
import { Home, BarChart3, Server, Shield } from 'lucide-react';
import SettingsModal from './setting/components/SettingsModal';
import { useUserRoleJotai } from '../jotai/middleware/useUserRoleJotai';

const GestionWeb: React.FC = () => {
  const { userRole, syncUserRole } = useUserRoleJotai();
  React.useEffect(() => { syncUserRole(); }, []);
  
  // Construir menú dinámicamente según el rol del usuario
  const menuItems: MenuItem[] = [
    { id: 'inicio', label: 'Inicio', icon: Home },
    { id: 'administrar-estaciones', label: 'Administrador de maquinas', icon: Server },
    ...(userRole === 'ADMIN' ? [
      { id: 'reportes', label: 'Reportes', icon: BarChart3 },
      { id: 'permisos', label: 'Gestión de Permisos', icon: Shield }
    ] : [])
  ];
  const location = useLocation();
  const navigate = useNavigate();
  const [showSettings, setShowSettings] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Deriva el menú activo desde la URL: /gestion-web/:section
  const path = location.pathname.replace(/\/+$/, ''); // remove trailing slash
  const parts = path.split('/').filter(Boolean); // ['gestion-web', 'reportes']
  const activeMenu = parts[1] || 'inicio';

  return (
  <div className="h-screen bg-gray-50 dark:bg-gray-900 flex flex-row overflow-hidden">
      {/* Overlay para mobile */}
      {sidebarOpen && (
        <div 
          className="fixed inset-0 bg-black bg-opacity-50 z-20 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      
      {/* Sidebar con estado responsivo */}
      <div className={`fixed md:static inset-y-0 left-0 z-30 transform transition-transform duration-300 ease-in-out md:transform-none ${
        sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
      }`}>
        <Sidebar
          activeMenu={activeMenu}
          menuItems={menuItems}
          onConfig={() => navigate('/gestion-web/settings', { state: { background: location } })}
          onMenuClick={() => setSidebarOpen(false)}
        />
      </div>
  <div className="flex-1 flex flex-col min-w-0 min-h-0 w-full">
        {/* Header/Topbar - Solo visible en otras secciones */}
        {activeMenu !== 'inicio' && (
          <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 md:px-6 py-4 h-16 flex-shrink-0">
            <div className="flex items-center justify-between">
              {/* Botón hamburguesa para mobile */}
              <button
                onClick={() => setSidebarOpen(true)}
                className="md:hidden p-2 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                aria-label="Abrir menú"
              >
                <svg className="w-6 h-6 text-gray-900 dark:text-gray-100" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
              <h1 className="text-lg md:text-xl font-semibold text-gray-900 dark:text-gray-100">
                {menuItems.find(item => item.id === activeMenu)?.label || 'GestionWeb'}
              </h1>
              <div className="w-10 md:hidden"></div> {/* Spacer para centrar el título */}
            </div>
          </header>
        )}

        {/* Main content: nested routes rendered by AppRoutes via Outlet */}
  <main className="flex-1 min-h-0 min-w-0 overflow-y-auto w-full h-full">
          <Outlet />
        </main>
      </div>
      {/* MODAL DE AJUSTES cuando se abre desde UI tradicional */}
      <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} />
    </div>
  );
};

export default GestionWeb;
