import {
  ChevronDown,
  Hand,
  LayoutDashboard,
  Layers3,
  LogOut,
  MessageSquareText,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  ReceiptText,
  Sparkles,
  ShieldCheck,
  Activity,
} from 'lucide-react';
import React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { authService } from '../../auth/services/authService';
import { useAuthJotai } from '../../../jotai/middleware/useAuthJotai';
import { useUserRoleJotai } from '../../../jotai/middleware/useUserRoleJotai';

type NavItem = {
  to: string;
  label: string;
  icon: React.ElementType;
  adminOnly?: boolean;
};

type NavGroupProps = {
  title: string;
  icon: React.ElementType;
  open: boolean;
  active: boolean;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
};

type DashboardSidebarProps = {
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
};

const GROUP_BUTTON_BASE = 'flex w-full items-center justify-between rounded-lg px-3 py-3 transition-colors';
const LINK_BASE = 'flex items-center space-x-3 rounded-lg px-3 py-2 text-sm transition-colors';

export default function DashboardSidebar({ collapsed = false, onToggleCollapsed }: DashboardSidebarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { clearAuth } = useAuthJotai();
  const { userRole, clearUserRole, syncUserRole } = useUserRoleJotai();
  const isAdmin = userRole === 'ADMIN';

  React.useEffect(() => { syncUserRole(); }, [syncUserRole]);

  const commercialActive = isAnyActive(location.pathname, ['/dashboard/inventario', '/dashboard/catalogos']);
  const iaActive = isAnyActive(location.pathname, ['/dashboard/ia/dominios', '/dashboard/ia-settings', '/dashboard/ia/agentes', '/dashboard/agentes']);
  const opsActive = isAnyActive(location.pathname, ['/dashboard/handoff', '/dashboard/pagos']);
  const adminActive = isAnyActive(location.pathname, ['/dashboard/admin/auditoria', '/dashboard/admin/salud']);

  const [commercialOpen, setCommercialOpen] = React.useState(commercialActive);
  const [iaOpen, setIaOpen] = React.useState(iaActive);
  const [opsOpen, setOpsOpen] = React.useState(opsActive);
  const [adminOpen, setAdminOpen] = React.useState(adminActive);

  React.useEffect(() => {
    if (commercialActive) setCommercialOpen(true);
    if (iaActive) setIaOpen(true);
    if (opsActive) setOpsOpen(true);
    if (adminActive) setAdminOpen(true);
  }, [commercialActive, iaActive, opsActive, adminActive]);

  const isActive = (path: string, exact = false) => (
    exact ? location.pathname === path : location.pathname === path || location.pathname.startsWith(`${path}/`)
  );

  const handleLogout = async () => {
    try {
      const refreshToken = localStorage.getItem('refreshToken');
      if (refreshToken) await authService.logout(refreshToken);
    } catch (error) {
      console.error('Error al cerrar sesión:', error);
    } finally {
      clearAuth();
      clearUserRole();
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
      navigate('/auth/login', { replace: true });
    }
  };

  const renderItem = (item: NavItem) => {
    if (item.adminOnly && !isAdmin) return null;
    const Icon = item.icon;
    return (
      <Link
        key={item.to}
        to={item.to}
        title={collapsed ? item.label : undefined}
        className={`${LINK_BASE} ${collapsed ? 'justify-center space-x-0 px-2' : ''} ${
          isActive(item.to)
            ? 'bg-white text-[#128C7E] shadow-sm'
            : 'text-[#5B6F66] hover:bg-white hover:text-[#10231C]'
        }`}
      >
        <Icon className="h-4 w-4" />
        {!collapsed && <span className="font-medium">{item.label}</span>}
      </Link>
    );
  };

  return (
    <aside className={`flex flex-col border-r border-[#D9E5DF] bg-white transition-all duration-200 ${collapsed ? 'w-20' : 'w-64'}`}>
      <div className="border-b border-[#D9E5DF] p-4">
        {collapsed ? (
          <div className="flex h-10 items-center justify-center">
            <button
              type="button"
              onClick={onToggleCollapsed}
              className="group relative flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg bg-[#128C7E] text-base font-bold text-white transition-colors hover:bg-[#0E766A]"
              aria-label="Mostrar sidebar"
            >
              <span className="absolute transition duration-150 group-hover:scale-75 group-hover:opacity-0 group-focus:scale-75 group-focus:opacity-0">
                🤖
              </span>
              <PanelLeftOpen className="absolute h-4 w-4 scale-75 opacity-0 transition duration-150 group-hover:scale-100 group-hover:opacity-100 group-focus:scale-100 group-focus:opacity-100" />
            </button>
          </div>
        ) : (
          <div className="flex h-10 items-center justify-between gap-3">
            <Link
              to="/dashboard"
              className="min-w-0 flex-1 rounded-lg px-2 py-1 transition-colors hover:bg-[#F7FAF8]"
            >
              <span className="block truncate text-lg font-bold text-[#10231C]">Administracion AI Pro</span>
            </Link>
            <button
              type="button"
              onClick={onToggleCollapsed}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#D9E5DF] text-[#5B6F66] transition-colors hover:bg-[#EEF4F1] hover:text-[#10231C]"
              title="Ocultar sidebar"
              aria-label="Ocultar sidebar"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      <nav className={`admin-scrollbar flex-1 space-y-3 overflow-y-auto ${collapsed ? 'p-3' : 'p-4'}`}>
        <Link
          to="/dashboard"
          title={collapsed ? 'Panel' : undefined}
          className={`flex items-center rounded-lg py-3 transition-colors ${collapsed ? 'justify-center px-2' : 'space-x-3 px-4'} ${
            isActive('/dashboard', true)
              ? 'bg-[#DDF4EF] text-[#128C7E]'
              : 'text-[#5B6F66] hover:bg-[#F7FAF8] hover:text-[#10231C]'
          }`}
        >
          <LayoutDashboard className="h-5 w-5" />
          {!collapsed && <span className="font-medium">Panel</span>}
        </Link>

        <NavGroup
          title="Comercial"
          icon={Package}
          open={commercialOpen}
          active={commercialActive}
          collapsed={collapsed}
          onToggle={() => {
            if (collapsed) {
              onToggleCollapsed?.();
              setCommercialOpen(true);
              return;
            }
            setCommercialOpen((value) => !value);
          }}
        >
          {[
            { to: '/dashboard/catalogos', label: 'Gestionar catalogos', icon: Layers3, adminOnly: true },
            { to: '/dashboard/inventario', label: 'Ofertas y disponibilidad', icon: Package },
          ].map(renderItem)}
        </NavGroup>

        <NavGroup
          title="IA"
          icon={Sparkles}
          open={iaOpen}
          active={iaActive}
          collapsed={collapsed}
          onToggle={() => {
            if (collapsed) {
              onToggleCollapsed?.();
              setIaOpen(true);
              return;
            }
            setIaOpen((value) => !value);
          }}
        >
          {[
            { to: '/dashboard/ia/dominios', label: 'Dominios IA', icon: Sparkles, adminOnly: true },
          ].map(renderItem)}
        </NavGroup>

        <NavGroup
          title="Operacion"
          icon={Hand}
          open={opsOpen}
          active={opsActive}
          collapsed={collapsed}
          onToggle={() => {
            if (collapsed) {
              onToggleCollapsed?.();
              setOpsOpen(true);
              return;
            }
            setOpsOpen((value) => !value);
          }}
        >
          {[
            { to: '/dashboard/handoff', label: 'Cola Handoff', icon: Hand },
            { to: '/dashboard/pagos', label: 'Validar pagos', icon: ReceiptText },
          ].map(renderItem)}
        </NavGroup>

        <NavGroup
          title="Seguridad y SRE"
          icon={ShieldCheck}
          open={adminOpen}
          active={adminActive}
          collapsed={collapsed}
          onToggle={() => {
            if (collapsed) {
              onToggleCollapsed?.();
              setAdminOpen(true);
              return;
            }
            setAdminOpen((value) => !value);
          }}
        >
          {[
            { to: '/dashboard/admin/auditoria', label: 'Pistas de Auditoría', icon: ShieldCheck, adminOnly: true },
            { to: '/dashboard/admin/salud', label: 'Salud del Sistema (SRE)', icon: Activity, adminOnly: true },
          ].map(renderItem)}
        </NavGroup>

        <Link
          to="/gestion-web/inicio"
          title={collapsed ? 'Gestion web' : undefined}
          className={`flex items-center rounded-lg py-3 text-[#5B6F66] transition-colors hover:bg-[#F7FAF8] hover:text-[#10231C] ${collapsed ? 'justify-center px-2' : 'space-x-3 px-4'}`}
        >
          <MessageSquareText className="h-5 w-5" />
          {!collapsed && <span className="font-medium">Gestion web</span>}
        </Link>
      </nav>

      <div className={`border-t border-[#D9E5DF] ${collapsed ? 'p-3' : 'p-4'}`}>
        <button
          onClick={handleLogout}
          title={collapsed ? 'Cerrar sesion' : undefined}
          className={`flex w-full items-center rounded-lg py-3 text-[#5B6F66] transition-colors hover:bg-red-50 hover:text-red-600 ${collapsed ? 'justify-center px-2' : 'space-x-3 px-4'}`}
        >
          <LogOut className="h-5 w-5" />
          {!collapsed && <span className="font-medium">Cerrar sesion</span>}
        </button>
      </div>
    </aside>
  );
}

function NavGroup({ title, icon: Icon, open, active, collapsed, onToggle, children }: NavGroupProps) {
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onToggle}
        className={`flex w-full items-center justify-center rounded-lg px-2 py-3 transition-colors ${active ? 'bg-[#DDF4EF] text-[#128C7E]' : 'text-[#5B6F66] hover:bg-[#F7FAF8] hover:text-[#10231C]'}`}
        title={title}
        aria-label={title}
      >
        <Icon className="h-5 w-5" />
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-[#D9E5DF] bg-[#F7FAF8] p-1">
      <button
        type="button"
        onClick={onToggle}
        className={`${GROUP_BUTTON_BASE} ${active ? 'bg-[#DDF4EF] text-[#128C7E]' : 'text-[#5B6F66] hover:bg-white hover:text-[#10231C]'}`}
      >
        <span className="flex items-center space-x-3">
          <Icon className="h-5 w-5" />
          <span className="font-medium">{title}</span>
        </span>
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="mt-1 space-y-1 pl-3">{children}</div>}
    </div>
  );
}

function isAnyActive(pathname: string, paths: string[]): boolean {
  return paths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}
