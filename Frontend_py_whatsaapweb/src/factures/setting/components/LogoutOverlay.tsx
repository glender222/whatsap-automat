import React from 'react';

interface LogoutOverlayProps {
  show: boolean;
}

/**
 * Overlay animado que se muestra durante el cierre de sesión
 */
const LogoutOverlay: React.FC<LogoutOverlayProps> = ({ show }) => {
  if (!show) return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-gradient-to-br from-red-50 via-white to-orange-50 animate-fadeIn">
      <div className="flex flex-col items-center gap-6 px-6 py-8 max-w-md w-full">
        {/* Icono de logout animado */}
        <div className="relative">
          <svg 
            className="w-20 h-20 text-red-600 animate-pulse" 
            fill="none" 
            stroke="currentColor" 
            viewBox="0 0 24 24"
          >
            <path 
              strokeLinecap="round" 
              strokeLinejoin="round" 
              strokeWidth={2} 
              d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" 
            />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-24 h-24 border-4 border-red-200 border-t-red-600 rounded-full animate-spin"></div>
          </div>
        </div>

        {/* Título y mensaje */}
        <div className="text-center">
          <h2 className="text-2xl font-bold text-gray-900 mb-2">
            Cerrando sesión...
          </h2>
          <p className="text-gray-600 text-sm">
            Desconectando WhatsApp y limpiando datos
          </p>
        </div>

        {/* Indicador de progreso */}
        <div className="flex items-center gap-2 text-sm text-red-600">
          <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse"></div>
          <span>🔴 Finalizando sesión de forma segura...</span>
        </div>
      </div>
    </div>
  );
};

export default LogoutOverlay;
