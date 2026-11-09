import { Menu, User, X } from 'lucide-react';
import type { Ref } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuthJotai } from '../../../jotai/middleware/useAuthJotai';
import { getWorkspacePage } from './workspaceNavigation';

interface DashboardTopbarProps {
  isAdmin: boolean;
  mobileOpen: boolean;
  onToggleMenu: () => void;
  menuButtonRef: Ref<HTMLButtonElement>;
  titleRef: Ref<HTMLHeadingElement>;
}

export default function DashboardTopbar({
  isAdmin,
  mobileOpen,
  onToggleMenu,
  menuButtonRef,
  titleRef,
}: DashboardTopbarProps) {
  const { pathname } = useLocation();
  const { user } = useAuthJotai();
  const { section, title } = getWorkspacePage(pathname);
  const userName = user?.nombre || user?.email || 'Usuario';
  const userRole = isAdmin ? 'Administrador' : 'Operador';
  const MenuIcon = mobileOpen ? X : Menu;

  return (
    <header className="col-start-1 row-start-1 flex min-h-16 items-center gap-3 border-b border-subtle bg-surface px-3 sm:px-6 lg:col-start-2">
      <button
        type="button"
        ref={menuButtonRef}
        aria-controls="workspace-navigation"
        aria-expanded={mobileOpen}
        aria-label={mobileOpen ? 'Cerrar navegación' : 'Abrir navegación'}
        onClick={onToggleMenu}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-secondary hover:bg-canvas
          focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 lg:hidden"
      >
        <MenuIcon size={20} aria-hidden="true" />
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-secondary">{section}</p>
        <h1 ref={titleRef} tabIndex={-1} className="truncate text-lg font-semibold text-primary">
          {title}
        </h1>
      </div>
      <div className="flex min-w-0 shrink-0 items-center gap-3" aria-label={`${userName}, ${userRole}`}>
        <div className="hidden max-w-44 text-right sm:block">
          <p className="truncate text-sm font-medium">{userName}</p>
          <p className="text-xs text-secondary">{userRole}</p>
        </div>
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
          <User size={18} aria-hidden="true" />
        </span>
      </div>
    </header>
  );
}
