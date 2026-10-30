
import React, { useState, useRef } from 'react';

interface EstacionCardProps {
  nombre: string;
  estado: string;
  color: string;
  email?: string;
  onClaveClick?: (email: string) => void;
}


const EstacionCard: React.FC<EstacionCardProps> = ({ nombre, estado, color, email, onClaveClick }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Cerrar el menú si se hace clic fuera
  React.useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    if (menuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [menuOpen]);

  return (
    <div className="bg-gray-50 rounded-xl p-4 w-full max-w-xs border border-gray-200 flex-shrink-0 relative">
      <div className="flex items-center gap-3 mb-3">
        <div className="relative">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
            <rect x="2" y="3" width="20" height="14" rx="2" fill="#e5e7eb" stroke="#9ca3af" strokeWidth="0.5"/>
            <rect x="3.5" y="4.5" width="17" height="11" rx="1" fill="#f9fafb"/>
            <rect x="6" y="17" width="12" height="2" rx="1" fill="#d1d5db"/>
          </svg>
          <div className="absolute -top-1 -right-1 flex gap-0.5">
            <div className="w-2 h-2 bg-gray-400 rounded-full"/>
            <div className="w-2 h-2 bg-gray-400 rounded-full"/>
          </div>
        </div>
        <span className="font-semibold text-gray-900 text-lg">{nombre}</span>
        <div className="ml-auto relative" ref={menuRef}>
          <button
            className="p-2 rounded-full hover:bg-gray-200 focus:outline-none"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label="Opciones"
          >
            <svg width="22" height="22" fill="none" viewBox="0 0 24 24">
              <circle cx="5" cy="12" r="2" fill="#6b7280" />
              <circle cx="12" cy="12" r="2" fill="#6b7280" />
              <circle cx="19" cy="12" r="2" fill="#6b7280" />
            </svg>
          </button>
          {menuOpen && (
            <div className="absolute right-0 mt-2 w-32 bg-white border border-gray-200 rounded-lg shadow-lg z-10">
              <button className="w-full text-left px-4 py-2 hover:bg-gray-100 text-sm" onClick={() => { setMenuOpen(false); /* Eliminar */ }}>Eliminar</button>
              <button className="w-full text-left px-4 py-2 hover:bg-gray-100 text-sm" onClick={() => { setMenuOpen(false); /* Editar */ }}>Editar</button>
              {email && onClaveClick && (
                <button className="w-full text-left px-4 py-2 hover:bg-gray-100 text-sm" onClick={() => { setMenuOpen(false); onClaveClick(email); }}>Clave</button>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="w-full h-2 bg-gray-200 rounded-full mb-2">
        <div 
          className={`h-2 rounded-full ${color === 'green' ? 'bg-green-500' : 'bg-blue-600'}`} 
          style={{ width: '65%' }}
        />
      </div>
      <button className={`w-full py-2 rounded-lg text-white font-semibold text-sm ${color === 'green' ? 'bg-green-600' : 'bg-blue-600'}`}>
        {estado}
      </button>
    </div>
  );
};

export default EstacionCard;
