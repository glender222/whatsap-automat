import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTheme } from '../../../jotai/middleware/useThemeJotai';

/**
 * Sección de configuración de tema
 */
const ThemeSection: React.FC = () => {
  const { theme, setTheme } = useTheme();
  const [dropdown, setDropdown] = useState(false);

  const handleTemaSelect = (newTema: 'Sistema' | 'Claro' | 'Oscuro') => {
    setTheme(newTema);
    setDropdown(false);
  };

  return (
    <div>
      <div className="flex items-center justify-between border-b border-gray-200 py-3 md:py-4">
        <span className="text-gray-700 dark:text-gray-300 text-base md:text-lg">Tema</span>
        <div className="relative">
          <button
            className="px-3 py-1.5 md:py-1 rounded bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 text-gray-800 dark:text-gray-200 text-sm md:text-lg flex items-center"
            onClick={() => setDropdown(!dropdown)}
          >
            {theme}
            <ChevronDown size={18} className="ml-2" />
          </button>
          {dropdown && (
            <div className="absolute right-0 mt-2 min-w-[120px] bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded shadow-lg z-10">
              <button
                className="block w-full px-4 py-2 text-left text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 text-sm md:text-base"
                onClick={() => handleTemaSelect('Sistema')}
              >
                Sistema
              </button>
              <button
                className="block w-full px-4 py-2 text-left text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 text-sm md:text-base"
                onClick={() => handleTemaSelect('Claro')}
              >
                Claro
              </button>
              <button
                className="block w-full px-4 py-2 text-left text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 text-sm md:text-base"
                onClick={() => handleTemaSelect('Oscuro')}
              >
                Oscuro
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ThemeSection;
