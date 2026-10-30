import { useState, useEffect, useRef } from 'react';
import { Monitor, Shield, Tag, TrendingUp, Mail, MoreVertical, Key, Edit2, Lock, Trash2 } from 'lucide-react';
import type { StationCardProps } from '../types/Station';

export function StationCard({ 
  station, 
  isCurrentUser, 
  onViewCredentials, 
  onEditStation, 
  onChangePassword, 
  onDelete 
}: StationCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !(menuRef.current as HTMLDivElement).contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    if (menuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  return (
    <div className={`relative group bg-white dark:bg-gray-800 rounded-2xl border-2 transition-all duration-300 hover:shadow-xl hover:-translate-y-0.5 ${
      isCurrentUser ? 'border-emerald-400 shadow-lg shadow-emerald-100 dark:shadow-emerald-900/50' : 'border-gray-200 dark:border-gray-600 hover:border-emerald-300 dark:hover:border-emerald-500'
    }`}>
      {isCurrentUser && (
        <div className="absolute -top-3 left-6 bg-gradient-to-r from-blue-500 to-blue-600 text-white text-xs font-bold px-4 py-1 rounded-full shadow-md">
          Tu estación
        </div>
      )}
      <div className="p-6">
        {/* Header */}
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-4">
            <div className="relative">
              <div className="w-14 h-14 bg-gradient-to-br from-emerald-500 to-emerald-600 rounded-2xl flex items-center justify-center shadow-lg">
                <Monitor className="w-7 h-7 text-white" />
              </div>
              <div className={`absolute -bottom-1 -right-1 w-5 h-5 rounded-full border-3 border-white dark:border-gray-800 shadow-md ${
                station.estado === 'Disponible' ? 'bg-emerald-500' : 'bg-gray-400'
              }`}></div>
            </div>
            <div>
              <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">{station.nombre}</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 flex items-center gap-2 mt-1">
                <Mail className="w-3.5 h-3.5" />
                {station.email || 'Sin email'}
              </p>
            </div>
          </div>
          {/* Options Menu */}
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen(!menuOpen)}
              className="p-2 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            >
              <MoreVertical className="w-5 h-5 text-gray-600 dark:text-gray-400" />
            </button>
            {menuOpen && (
              <div className="absolute right-0 mt-2 w-48 bg-white dark:bg-gray-700 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-600 py-2 z-50 animate-scale-in">
                <button 
                  type="button"
                  onClick={() => {
                    onViewCredentials?.(station);
                    setMenuOpen(false);
                  }}
                  className="w-full text-left px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-600 text-sm flex items-center gap-3 text-gray-700 dark:text-gray-200 transition-colors"
                >
                  <Key className="w-4 h-4" />
                  Ver credenciales
                </button>
                {!isCurrentUser && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        onEditStation?.(station);
                        setMenuOpen(false);
                      }}
                      className="w-full text-left px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-600 text-sm flex items-center gap-3 text-gray-700 dark:text-gray-200 transition-colors"
                    >
                      <Edit2 className="w-4 h-4" />
                      Editar estación
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onChangePassword?.(station);
                        setMenuOpen(false);
                      }}
                      className="w-full text-left px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-600 text-sm flex items-center gap-3 text-gray-700 dark:text-gray-200 transition-colors"
                    >
                      <Lock className="w-4 h-4" />
                      Cambiar contraseña
                    </button>
                    <div className="border-t border-gray-100 dark:border-gray-600 my-1"></div>
                    <button
                      type="button"
                      onClick={() => {
                        onDelete?.(station);
                        setMenuOpen(false);
                      }}
                      className="w-full text-left px-4 py-2.5 hover:bg-red-50 dark:hover:bg-red-900/30 text-sm flex items-center gap-3 text-red-600 dark:text-red-400 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                      Eliminar
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
        {/* Role Badge */}
        <div className="flex items-center gap-2 mb-4">
          <Shield className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
          <select
            value={station.rol}
            disabled
            aria-readonly="true"
            className="bg-gradient-to-r from-emerald-500 to-emerald-600 text-white px-4 py-1.5 rounded-lg text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-2 dark:focus:ring-offset-gray-800 cursor-default transition-all"
          >
            <option value="ADMIN">ADMIN</option>
            <option value="EMPLEADO">EMPLEADO</option>
          </select>
        </div>
        {/* Work Tags */}
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-300">
            <Tag className="w-4 h-4" />
            Etiquetas de trabajo
          </div>
          <div className="flex flex-wrap gap-2">
            {station.etiquetasBot.map((tag: string, idx: number) => (
              <span
                key={idx}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-gradient-to-r from-purple-100 to-purple-50 dark:from-purple-900/30 dark:to-purple-800/30 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-700"
              >
                <div className="w-2 h-2 rounded-full bg-purple-500"></div>
                {tag}
              </span>
            ))}
          </div>
        </div>
        {/* Performance Button */}
        <button className="mt-5 w-full bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-600 hover:to-emerald-700 text-white py-3 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 transition-all shadow-lg shadow-emerald-200 dark:shadow-emerald-900/50 hover:shadow-xl group">
          <TrendingUp className="w-4 h-4 transition-transform group-hover:scale-110" />
          Ver rendimiento
        </button>
      </div>
    </div>
  );
}
