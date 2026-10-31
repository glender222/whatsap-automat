import React, { useState, useEffect, useCallback } from 'react';
import {
  MessageSquare,
  Bot,
  Zap,
  ShieldCheck,
  Activity,
  Share2,
  Package,
  Settings,
  ChevronDown,
  Search,
  Bell,
  Moon,
  Sun,
  PanelLeftClose,
  PanelLeftOpen,
  Check,
  Building2,
  User,
  LogOut,
} from 'lucide-react';
import { MOCK_TENANTS, type TenantSummary, type OperatorPresence } from './mock-contracts';

export interface UnifiedShellProps {
  children?: React.ReactNode;
  activeModule?: string;
  onSelectModule?: (moduleId: string) => void;
}

export const UnifiedWorkspaceShellSpec: React.FC<UnifiedShellProps> = ({
  children,
  activeModule = 'inbox',
  onSelectModule,
}) => {
  const [collapsed, setCollapsed] = useState(false);
  const [currentTenant, setCurrentTenant] = useState<TenantSummary>(MOCK_TENANTS[0]);
  const [tenantDropdownOpen, setTenantDropdownOpen] = useState(false);
  const [operatorPresence, setOperatorPresence] = useState<OperatorPresence>('available');
  const [presenceDropdownOpen, setPresenceDropdownOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(false);

  // Command Palette keyboard shortcut: Ctrl+K / Cmd+K
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
      }
      if (e.key === 'Escape') {
        setTenantDropdownOpen(false);
        setPresenceDropdownOpen(false);
        setCommandPaletteOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const navItems = [
    { id: 'inbox', label: 'Inbox Omnicanal', icon: MessageSquare, badge: 3 },
    { id: 'agent-studio', label: 'Agent Studio', icon: Bot },
    { id: 'automations', label: 'Automatizaciones', icon: Zap },
    { id: 'approvals', label: 'Aprobaciones', icon: ShieldCheck, badge: 1, badgeVariant: 'warning' },
    { id: 'operations', label: 'Operaciones & Ops', icon: Activity },
    { id: 'channels', label: 'Canales & Conexiones', icon: Share2 },
    { id: 'commercial', label: 'Comercial & Stock', icon: Package },
    { id: 'settings', label: 'Configuración', icon: Settings },
  ];

  return (
    <div className={`flex h-screen w-screen overflow-hidden ${darkMode ? 'dark bg-[#0B0F19] text-slate-100' : 'bg-slate-50 text-slate-900'}`}>
      {/* ----------------- SIDEBAR ----------------- */}
      <aside
        className={`flex flex-col border-r transition-all duration-200 z-20 ${
          darkMode ? 'bg-[#131B2E] border-slate-800' : 'bg-white border-slate-200'
        } ${collapsed ? 'w-16' : 'w-60'}`}
        aria-label="Navegación principal"
      >
        {/* Brand Header */}
        <div className="flex h-14 items-center justify-between border-b px-3 border-inherit">
          {!collapsed && (
            <div className="flex items-center gap-2 overflow-hidden">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-teal-600 text-white font-bold">
                W
              </div>
              <span className="truncate font-semibold text-sm tracking-tight">
                Whatsap-Automat
              </span>
            </div>
          )}
          {collapsed && (
            <div className="mx-auto flex h-8 w-8 items-center justify-center rounded-lg bg-teal-600 text-white font-bold">
              W
            </div>
          )}
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-600"
            title={collapsed ? 'Expandir barra lateral' : 'Colapsar barra lateral'}
            aria-label={collapsed ? 'Expandir barra lateral' : 'Colapsar barra lateral'}
          >
            {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        </div>

        {/* Tenant Switcher Pill */}
        <div className="p-2 border-b border-inherit">
          <div className="relative">
            <button
              type="button"
              onClick={() => setTenantDropdownOpen(!tenantDropdownOpen)}
              className={`flex w-full items-center justify-between rounded-lg p-2 text-left text-xs transition-colors ${
                darkMode ? 'hover:bg-slate-800/80 bg-slate-800/40' : 'hover:bg-slate-100 bg-slate-50'
              }`}
              title={collapsed ? currentTenant.name : undefined}
              aria-haspopup="dialog"
              aria-expanded={tenantDropdownOpen}
            >
              <div className="flex items-center gap-2 overflow-hidden">
                <Building2 size={16} className="text-teal-600 shrink-0" />
                {!collapsed && (
                  <span className="truncate font-medium">{currentTenant.name}</span>
                )}
              </div>
              {!collapsed && <ChevronDown size={14} className="text-slate-400 shrink-0" />}
            </button>

            {tenantDropdownOpen && (
              <div
                className={`absolute left-0 top-full mt-1 w-56 rounded-lg border p-1 shadow-xl z-50 ${
                  darkMode ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'
                }`}
                role="dialog"
                aria-label="Selector de organización"
              >
                <div className="px-2 py-1 text-[11px] font-semibold text-slate-400 uppercase">
                  Organizaciones
                </div>
                {MOCK_TENANTS.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => {
                      setCurrentTenant(t);
                      setTenantDropdownOpen(false);
                    }}
                    className="flex w-full items-center justify-between rounded px-2 py-1.5 text-xs hover:bg-teal-50 dark:hover:bg-teal-950/40 text-left"
                  >
                    <span className="truncate">{t.name}</span>
                    {t.id === currentTenant.id && <Check size={14} className="text-teal-600" />}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Navigation Modules */}
        <nav className="flex-1 space-y-1 p-2 overflow-y-auto" role="navigation">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeModule === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectModule?.(item.id)}
                className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-xs font-medium transition-colors ${
                  isActive
                    ? 'bg-teal-600 text-white shadow-sm'
                    : darkMode
                    ? 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                } ${collapsed ? 'justify-center px-0' : ''}`}
                title={collapsed ? item.label : undefined}
                aria-current={isActive ? 'page' : undefined}
              >
                <Icon size={18} className="shrink-0" />
                {!collapsed && <span className="flex-1 text-left truncate">{item.label}</span>}
                {!collapsed && item.badge && (
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                      item.badgeVariant === 'warning'
                        ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200'
                        : isActive
                        ? 'bg-white/20 text-white'
                        : 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                    }`}
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Sidebar Footer */}
        <div className="border-t p-2 border-inherit flex items-center justify-between">
          <button
            type="button"
            onClick={() => setDarkMode(!darkMode)}
            className="rounded p-2 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-600"
            title={darkMode ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}
            aria-label={darkMode ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}
          >
            {darkMode ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          {!collapsed && (
            <span className="text-[10px] text-slate-400">v0.4.0-preview</span>
          )}
        </div>
      </aside>

      {/* ----------------- MAIN VIEWPORT ----------------- */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Topbar */}
        <header
          className={`flex h-14 shrink-0 items-center justify-between border-b px-4 transition-colors z-10 ${
            darkMode ? 'bg-[#131B2E] border-slate-800' : 'bg-white border-slate-200'
          }`}
        >
          {/* Search Trigger */}
          <button
            type="button"
            onClick={() => setCommandPaletteOpen(true)}
            className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs text-slate-400 transition-colors w-64 ${
              darkMode ? 'border-slate-700 bg-slate-900/60 hover:border-slate-600' : 'border-slate-200 bg-slate-50 hover:border-slate-300'
            }`}
          >
            <Search size={14} />
            <span className="flex-1 text-left truncate">Buscar o comando...</span>
            <kbd className="rounded border px-1.5 text-[10px] font-mono border-inherit">Ctrl K</kbd>
          </button>

          {/* Right Header Actions */}
          <div className="flex items-center gap-3">
            {/* Operator Presence */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setPresenceDropdownOpen(!presenceDropdownOpen)}
                className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
                  operatorPresence === 'available'
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:border-emerald-800 dark:text-emerald-300'
                    : operatorPresence === 'busy'
                    ? 'border-amber-200 bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:border-amber-800 dark:text-amber-300'
                    : 'border-slate-200 bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
                }`}
                aria-label="Estado del operador"
              >
                <span
                  className={`h-2 w-2 rounded-full ${
                    operatorPresence === 'available'
                      ? 'bg-emerald-500'
                      : operatorPresence === 'busy'
                      ? 'bg-amber-500'
                      : 'bg-slate-400'
                  }`}
                />
                <span className="capitalize">{operatorPresence === 'available' ? 'Disponible' : operatorPresence === 'busy' ? 'Ocupado' : 'Offline'}</span>
                <ChevronDown size={12} />
              </button>

              {presenceDropdownOpen && (
                <div
                  className={`absolute right-0 top-full mt-1 w-36 rounded-lg border p-1 shadow-lg z-50 ${
                    darkMode ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'
                  }`}
                >
                  <button
                    onClick={() => {
                      setOperatorPresence('available');
                      setPresenceDropdownOpen(false);
                    }}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-left hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    <span className="h-2 w-2 rounded-full bg-emerald-500" />
                    <span>Disponible</span>
                  </button>
                  <button
                    onClick={() => {
                      setOperatorPresence('busy');
                      setPresenceDropdownOpen(false);
                    }}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-left hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    <span className="h-2 w-2 rounded-full bg-amber-500" />
                    <span>Ocupado</span>
                  </button>
                  <button
                    onClick={() => {
                      setOperatorPresence('offline');
                      setPresenceDropdownOpen(false);
                    }}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-left hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    <span className="h-2 w-2 rounded-full bg-slate-400" />
                    <span>Desconectado</span>
                  </button>
                </div>
              )}
            </div>

            {/* Notifications */}
            <button
              type="button"
              className="relative rounded-lg p-2 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-600"
              aria-label="Ver 3 notificaciones"
            >
              <Bell size={18} />
              <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-red-500" />
            </button>

            {/* User Profile Avatar */}
            <div className="flex items-center gap-2 border-l pl-3 border-inherit">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-teal-100 text-teal-800 font-bold text-xs dark:bg-teal-900 dark:text-teal-200">
                AP
              </div>
            </div>
          </div>
        </header>

        {/* Dynamic Workspace Container */}
        <main className="flex-1 overflow-hidden" role="main">
          {children || (
            <div className="flex h-full items-center justify-center text-slate-400 text-sm">
              Selecciona un módulo en la barra lateral para comenzar.
            </div>
          )}
        </main>
      </div>

      {/* Command Palette Modal */}
      {commandPaletteOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-black/50 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="Paleta de comandos"
        >
          <div
            className={`w-full max-w-lg rounded-xl border p-3 shadow-2xl ${
              darkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-white border-slate-200 text-slate-900'
            }`}
          >
            <div className="flex items-center gap-2 border-b pb-2 border-inherit">
              <Search size={18} className="text-slate-400" />
              <input
                autoFocus
                placeholder="Escribe un comando o busca en el workspace..."
                className="w-full bg-transparent text-sm focus:outline-none"
              />
              <kbd className="text-[10px] font-mono text-slate-400">ESC</kbd>
            </div>
            <div className="py-2 text-xs text-slate-400 space-y-1">
              <div className="px-2 py-1 font-semibold uppercase text-[10px]">Acciones Rápidas</div>
              <button
                onClick={() => {
                  onSelectModule?.('inbox');
                  setCommandPaletteOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-teal-50 dark:hover:bg-teal-950/40 text-left"
              >
                <MessageSquare size={14} />
                <span>Ir al Inbox Omnicanal</span>
              </button>
              <button
                onClick={() => {
                  onSelectModule?.('agent-studio');
                  setCommandPaletteOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-teal-50 dark:hover:bg-teal-950/40 text-left"
              >
                <Bot size={14} />
                <span>Crear nuevo Agente en Agent Studio</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
