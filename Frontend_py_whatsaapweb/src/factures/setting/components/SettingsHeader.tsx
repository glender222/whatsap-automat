import React from 'react';
import { X, Settings } from 'lucide-react';

interface SettingsHeaderProps {
  selectedMenu: string;
  onMenuChange: (menu: string) => void;
  onClose: () => void;
}

/**
 * Header móvil para el modal de configuración
 */
const SettingsHeader: React.FC<SettingsHeaderProps> = ({ 
  selectedMenu, 
  onMenuChange, 
  onClose 
}) => {
  return (
    <div className="md:hidden bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
      <div className="flex items-center justify-between px-4 py-3">
        <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Configuración</h1>
        <button
          className="text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
          onClick={onClose}
          aria-label="Cerrar"
        >
          <X size={24} />
        </button>
      </div>
      
      <nav className="flex border-t border-gray-200 dark:border-gray-700">
        <button
          className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
            selectedMenu === 'general'
              ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400'
              : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
          }`}
          onClick={() => onMenuChange('general')}
        >
          <Settings size={18} />
          General
        </button>
      </nav>
    </div>
  );
};

export default SettingsHeader;
