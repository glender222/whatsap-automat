import React from 'react';
import { X, Settings } from 'lucide-react';

interface SettingsSidebarProps {
  selectedMenu: string;
  onMenuChange: (menu: string) => void;
  onClose: () => void;
}

/**
 * Sidebar de navegación para desktop en el modal de configuración
 */
const SettingsSidebar: React.FC<SettingsSidebarProps> = ({ 
  selectedMenu, 
  onMenuChange, 
  onClose 
}) => {
  return (
    <div className="hidden md:flex w-1/4 min-w-[200px] max-w-[270px] bg-gray-50 dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 flex-col py-6 px-4">
      <button
        className="mb-6 ml-1 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
        onClick={onClose}
        aria-label="Cerrar"
      >
        <X size={26} />
      </button>
      
      <nav className="flex flex-col gap-2">
        <button
          className={`flex items-center gap-3 px-4 py-2 rounded-lg text-base font-medium transition-colors ${
            selectedMenu === 'general'
              ? 'bg-white dark:bg-gray-700 shadow text-gray-900 dark:text-gray-100'
              : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
          }`}
          onClick={() => onMenuChange('general')}
        >
          <Settings size={20} />
          General
        </button>
      </nav>
    </div>
  );
};

export default SettingsSidebar;
