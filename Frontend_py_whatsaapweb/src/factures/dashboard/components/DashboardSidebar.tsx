import { LogOut, MessageSquareText, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { workspaceSections } from './workspaceNavigation';

interface DashboardSidebarProps {
  collapsed: boolean;
  mobileOpen: boolean;
  isAdmin: boolean;
  onToggleCollapsed: () => void;
  onNavigate: () => void;
  onLogout: () => void;
}

const navigationControl =
  'flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm font-medium text-secondary ' +
  'transition-colors hover:bg-canvas hover:text-primary focus-visible:outline focus-visible:outline-2 ' +
  'focus-visible:outline-offset-2 focus-visible:outline-emerald-600';

export default function DashboardSidebar({
  collapsed,
  mobileOpen,
  isAdmin,
  onToggleCollapsed,
  onNavigate,
  onLogout,
}: DashboardSidebarProps) {
  const labelClass = collapsed ? 'min-w-0 truncate lg:sr-only' : 'min-w-0 truncate';
  const itemClass = collapsed ? 'lg:justify-center lg:px-0' : '';
  const collapseLabel = collapsed ? 'Expandir navegación' : 'Contraer navegación';
  const CollapseIcon = collapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <aside
      id="workspace-navigation"
      className={`${mobileOpen ? 'flex' : 'hidden'} col-start-1 row-start-2 max-h-[45dvh] min-h-0
        flex-col border-b border-subtle bg-surface lg:row-span-3 lg:row-start-1 lg:flex
        lg:max-h-none lg:border-b-0 lg:border-r ${collapsed ? 'lg:w-[4.75rem]' : 'lg:w-[14rem]'}`}
    >
      <div className={`hidden h-16 shrink-0 items-center gap-2 border-b border-subtle p-3 lg:flex
        ${collapsed ? 'justify-center' : 'justify-between'}`}>
        {!collapsed && (
          <NavLink
            to="/gestion-web/inicio"
            className="flex min-w-0 items-center gap-2 rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-700 text-white">
              <MessageSquareText size={17} aria-hidden="true" />
            </span>
            <span className="truncate text-sm font-semibold">Whatsap Automat</span>
          </NavLink>
        )}
        <button
          type="button"
          aria-label={collapseLabel}
          title={collapseLabel}
          onClick={onToggleCollapsed}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-secondary hover:bg-canvas
            focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600"
        >
          <CollapseIcon size={18} aria-hidden="true" />
        </button>
      </div>

      <nav aria-label="Espacio de trabajo" className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {workspaceSections.map((section) => (
          <div key={section.label}>
            <p className={`mb-1 px-3 text-xs font-semibold text-secondary ${collapsed ? 'lg:sr-only' : ''}`}>
              {section.label}
            </p>
            <ul className="space-y-0.5">
              {section.links.filter((item) => isAdmin || !item.adminOnly).map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.exact}
                    onClick={onNavigate}
                    title={collapsed ? item.label : undefined}
                    className={({ isActive }) => `${navigationControl} ${itemClass} ${
                      isActive ? 'bg-emerald-50 !text-emerald-800 dark:bg-emerald-950 dark:!text-emerald-200' : ''
                    }`}
                  >
                    <item.icon size={18} aria-hidden="true" className="shrink-0" />
                    <span className={labelClass}>{item.label}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t border-subtle p-3">
        <button
          type="button"
          onClick={onLogout}
          title={collapsed ? 'Cerrar sesión' : undefined}
          className={`${navigationControl} ${itemClass} hover:!text-red-700 dark:hover:!text-red-300`}
        >
          <LogOut size={18} aria-hidden="true" className="shrink-0" />
          <span className={labelClass}>Cerrar sesión</span>
        </button>
      </div>
    </aside>
  );
}
