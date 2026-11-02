import React from 'react';
import type {
  ChannelProvider,
  ConversationStatus,
  FunctionalPlaneId,
  FunctionalPlaneItem,
} from '../types';
import { ChannelFilterTabs } from '../components/ChannelFilterTabs';
import { Search, X, Activity, Cpu, Layers, ShieldCheck } from 'lucide-react';

export interface NavigationPanelProps {
  currentChannel: 'all' | ChannelProvider;
  onSelectChannel: (channel: 'all' | ChannelProvider) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  statusFilter: ConversationStatus | 'all' | 'mine' | 'sla_risk';
  onSelectStatusFilter: (status: ConversationStatus | 'all' | 'mine' | 'sla_risk') => void;
  activeFunctionalPlane?: FunctionalPlaneId;
  onSelectFunctionalPlane?: (plane: FunctionalPlaneId) => void;
  functionalPlanes?: FunctionalPlaneItem[];
  unreadTotalsByChannel?: Partial<Record<ChannelProvider | 'all', number>>;
  className?: string;
}

const STATUS_FILTERS: Array<{
  id: ConversationStatus | 'all' | 'mine' | 'sla_risk';
  label: string;
}> = [
  { id: 'all', label: 'Todos' },
  { id: 'mine', label: 'Míos' },
  { id: 'ai_handling', label: 'IA Activa' },
  { id: 'pending_handoff', label: 'Handoff' },
  { id: 'sla_risk', label: 'Riesgo SLA' },
];

export const NavigationPanel: React.FC<NavigationPanelProps> = ({
  currentChannel,
  onSelectChannel,
  searchQuery,
  onSearchChange,
  statusFilter,
  onSelectStatusFilter,
  activeFunctionalPlane = 'operations',
  onSelectFunctionalPlane,
  functionalPlanes = [],
  unreadTotalsByChannel = {},
  className = '',
}) => {
  const getPlaneIcon = (plane: FunctionalPlaneId) => {
    switch (plane) {
      case 'operations':
        return <Activity size={14} aria-hidden="true" />;
      case 'automation':
        return <Cpu size={14} aria-hidden="true" />;
      case 'platform':
        return <Layers size={14} aria-hidden="true" />;
      case 'admin':
        return <ShieldCheck size={14} aria-hidden="true" />;
    }
  };

  return (
    <nav
      role="navigation"
      aria-label="Navegación principal y canales"
      className={`flex flex-col w-64 shrink-0 border-r bg-white dark:bg-[#131B2E] border-slate-200 dark:border-slate-800 ${className}`}
    >
      {/* Functional Planes (Navigation sections) */}
      {functionalPlanes.length > 0 && (
        <div className="p-2 border-b border-inherit space-y-1">
          <p className="px-2 pt-1 pb-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">
            Planos Funcionales
          </p>
          <div className="space-y-0.5">
            {functionalPlanes.map((p) => {
              const isActive = activeFunctionalPlane === p.plane;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onSelectFunctionalPlane?.(p.plane)}
                  className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 ${
                    isActive
                      ? 'bg-teal-50 text-teal-900 dark:bg-teal-950/60 dark:text-teal-200 font-semibold'
                      : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {getPlaneIcon(p.plane)}
                    <span>{p.label}</span>
                  </div>
                  {p.badge !== undefined && p.badge > 0 && (
                    <span className="rounded-full bg-teal-600 px-1.5 py-0.2 text-[10px] font-bold text-white">
                      {p.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Channel Tabs */}
      <div className="p-3 border-b border-inherit space-y-2.5">
        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Canales</p>
        <ChannelFilterTabs
          currentChannel={currentChannel}
          onSelectChannel={onSelectChannel}
          unreadTotals={unreadTotalsByChannel}
        />

        {/* Debounced / Instant Search */}
        <div className="relative" role="search">
          <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" aria-hidden="true" />
          <input
            type="search"
            role="searchbox"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Buscar por nombre o teléfono..."
            aria-label="Buscar por nombre o teléfono"
            className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40 pl-8 pr-7 py-1.5 text-xs text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-500"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => onSearchChange('')}
              className="absolute right-2 top-2 p-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              aria-label="Limpiar búsqueda"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Operational Status Filter Pills */}
      <div className="p-3">
        <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">
          Estado Operativo
        </p>
        <div
          role="radiogroup"
          aria-label="Filtro de estado de conversación"
          className="flex flex-wrap gap-1"
        >
          {STATUS_FILTERS.map((s) => {
            const isSelected = statusFilter === s.id;
            return (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={isSelected}
                tabIndex={isSelected ? 0 : -1}
                onClick={() => onSelectStatusFilter(s.id)}
                className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 ${
                  isSelected
                    ? 'bg-teal-600 text-white shadow-sm font-semibold'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
                }`}
              >
                {s.label}
              </button>
            );
          })}
        </div>
      </div>
    </nav>
  );
};
