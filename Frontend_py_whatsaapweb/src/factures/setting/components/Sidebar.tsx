import React, { useState, useRef, useEffect } from 'react';
import { Settings, LogOut } from 'lucide-react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuthJotai } from '../../../jotai/middleware/useAuthJotai';
import GlobalTransition from '../../../shared/components/GlobalTransition';
import { useUserRoleJotai } from '../../../jotai/middleware/useUserRoleJotai';

export interface MenuItem {
  id: string;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}

interface SidebarProps {
  activeMenu: string;
  setActiveMenu?: (id: string) => void;
  menuItems: MenuItem[];
  onConfig?: () => void;
  onLogout?: () => void;
  onMenuClick?: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  activeMenu,
  setActiveMenu,
  menuItems,
  onConfig,
  onMenuClick,
}) => {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showTransition, setShowTransition] = useState(false);
  const [transitionMsg, setTransitionMsg] = useState('Cerrando sesión...');
  const settingsBtnRef = useRef<HTMLButtonElement>(null);
  const { clearAuth } = useAuthJotai();
  const { userRole } = useUserRoleJotai();
  const navigate = useNavigate();

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const menu = document.getElementById('sidebar-settings-popup');
      if (
        settingsBtnRef.current &&
        !settingsBtnRef.current.contains(event.target as Node) &&
        (!menu || !menu.contains(event.target as Node))
      ) {
        setSettingsOpen(false);
      }
    }
    if (settingsOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [settingsOpen]);

  const handleLogout = () => {
    setSettingsOpen(false);
    setTransitionMsg('Cerrando sesión...');
    setShowTransition(true);
    setTimeout(() => {
      clearAuth();
      navigate('/auth/login');
      setShowTransition(false);
    }, 1500);
  };

  const handleReturnClick = (e: React.MouseEvent) => {
    e.preventDefault();
    if (onMenuClick) onMenuClick();

    try {
      // Intentar obtener la ventana con nombre 'w_chat_panel'
      const chatWin = window.open('', 'w_chat_panel');
      if (chatWin && !chatWin.closed) {
        if (chatWin === window) {
          // Estamos dentro de la pestaña del chat. Intentar enfocar dashboard si existe, sino navegar aquí
          const dashWin = window.open('', 'w_dashboard');
          if (dashWin && !dashWin.closed) {
            try { dashWin.focus(); } catch {}
            try { window.close(); } catch {}
          } else {
            navigate('/dashboard');
          }
        } else {
          // Cerrar la pestaña del chat y navegar (o permanecer) en dashboard
          try { chatWin.close(); } catch (err) { console.error(err); }
          navigate('/dashboard');
        }
      } else {
        // No hay pestaña abierta, navegar al dashboard
        navigate('/dashboard');
      }
    } catch (err) {
      console.error('Error al intentar cerrar/abrir pestañas:', err);
      navigate('/dashboard');
    }
  };

  return (
    <>
      <GlobalTransition show={showTransition} message={transitionMsg} zIndex={9999} />
      <div className="w-16 h-screen bg-gray-800 text-white flex flex-col relative">
        {/* WhatsApp / Return Button: visible para todos, inactivo para no-admins (misma apariencia, sin hover) */}
        <div className="p-4 border-b border-gray-700">
          <button
            onClick={(e) => {
              if (userRole === 'ADMIN') {
                handleReturnClick(e as any);
              } else {
                // prevenir acción para no-admins
                e.preventDefault();
              }
            }}
            aria-label="Volver al dashboard"
            className="w-10 h-10 rounded-full flex items-center justify-center bg-green-500"
          >
            <div className="w-6 h-6 bg-white rounded-full flex items-center justify-center">
              <span className="text-green-500 text-xs font-bold">W</span>
            </div>
          </button>
        </div>
        {/* Navigation Menu */}
        <nav className="flex-1 py-4">
          {menuItems.map((item) => {
            const IconComponent = item.icon;
            return (
              <div key={item.id} className="relative group">
                <NavLink
                  to={`/gestion-web/${item.id}`}
                  onClick={() => {
                    setActiveMenu && setActiveMenu(item.id);
                    onMenuClick && onMenuClick();
                  }}
                  className={({ isActive }) => `w-full flex items-center justify-center px-4 py-4 hover:bg-gray-700 transition-colors ${isActive || activeMenu === item.id ? 'bg-gray-700 border-r-2 border-blue-500' : ''}`}
                >
                  <IconComponent size={24} className="flex-shrink-0" />
                </NavLink>
                {/* Tooltip */}
                <div className="absolute left-full top-1/2 transform -translate-y-1/2 ml-2 px-2 py-1 bg-gray-900 text-white text-sm rounded opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 whitespace-nowrap z-50">
                  {item.label}
                  <div className="absolute right-full top-1/2 transform -translate-y-1/2 w-0 h-0 border-t-4 border-b-4 border-r-4 border-transparent border-r-gray-900"></div>
                </div>
              </div>
            );
          })}
        </nav>
        {/* Settings at bottom */}
        <div className="p-4 border-t border-gray-700 relative flex justify-center items-center">
          <button
            ref={settingsBtnRef}
            className="w-10 h-10 flex items-center justify-center hover:bg-gray-700 rounded-lg transition-colors"
            onClick={() => setSettingsOpen((v) => !v)}
          >
            <Settings size={24} className="flex-shrink-0" />
          </button>
          {/* Ajustes popup */}
          {settingsOpen && (
            <div
              id="sidebar-settings-popup"
              className="absolute left-[110%] bottom-1 min-w-[180px] bg-white border border-gray-300 shadow-xl rounded-lg py-2 z-50"
              style={{
                boxShadow: '0 2px 16px rgba(0,0,0,0.12)',
              }}
            >
              {/* Configuración */}
              <button
                className="w-full flex items-center px-4 py-3 text-gray-800 hover:bg-gray-50 transition-colors text-base"
                onClick={e => {
                  e.stopPropagation();
                  if (onConfig) onConfig();
                  setSettingsOpen(false);
                }}
              >
                <Settings size={22} className="mr-2 text-gray-700" />
                Configuración
              </button>
              {/* Salir */}
              <button
                className="w-full flex items-center px-4 py-3 text-gray-800 hover:bg-gray-50 transition-colors text-base"
                onClick={e => {
                  e.stopPropagation();
                  handleLogout();
                }}
              >
                <LogOut size={22} className="mr-2 text-gray-700" />
                Cerrar sesión
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
};

export default Sidebar;