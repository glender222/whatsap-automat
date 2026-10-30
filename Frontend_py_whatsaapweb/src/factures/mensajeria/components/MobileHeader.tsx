import React from 'react';

interface MobileHeaderProps {
  selectedChatName: string;
  onBack: () => void;
  onMenuOpen: () => void;
}

/**
 * Componente MobileHeader
 * Header para vista móvil con navegación
 * Principio de Responsabilidad Única: Solo maneja el header móvil
 */
const MobileHeader: React.FC<MobileHeaderProps> = ({
  selectedChatName,
  onBack,
  onMenuOpen
}) => {
  return (
    <div className="md:hidden bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-3">
      {/* Botón de regreso */}
      <button
        onClick={onBack}
        className="p-2 rounded-md hover:bg-gray-100 transition-colors"
        aria-label="Volver a chats"
      >
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
      </button>
      
      <h2 className="text-lg font-semibold text-gray-900 truncate flex-1">
        {selectedChatName}
      </h2>
      
      {/* Botón hamburguesa a la derecha */}
      <button
        onClick={onMenuOpen}
        className="p-2 rounded-md hover:bg-gray-100 transition-colors"
        aria-label="Abrir menú"
      >
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
    </div>
  );
};

export default MobileHeader;
