import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';

interface BotModalitySectionProps {
  botModality: 'options' | 'words' | null;
  onBotModalityChange: (value: 'options' | 'words' | null) => void;
}

/**
 * Sección de configuración de modalidad del bot
 * Solo una opción puede estar activa a la vez
 */
const BotModalitySection: React.FC<BotModalitySectionProps> = ({
  botModality,
  onBotModalityChange
}) => {
  const [dropdown, setDropdown] = useState(false);

  const handleOptionChange = (option: 'options' | 'words') => {
    // Si la opción ya está activa, desactivarla
    if (botModality === option) {
      onBotModalityChange(null);
    } else {
      // Si hay otra opción activa, desactivarla y activar la nueva
      onBotModalityChange(option);
    }
  };

  return (
    <div>
      <div className="flex flex-col md:flex-row md:items-center md:justify-between border-b border-gray-200 dark:border-gray-700 py-3 md:py-4 gap-3 md:gap-0">
        <div>
          <div className="text-gray-700 dark:text-gray-300 text-base md:text-lg">Modalidad de tu Bot</div>
          <div className="text-xs md:text-sm text-gray-500 dark:text-gray-400">Selecciona cómo interactuará tu bot con los usuarios</div>
        </div>
        <div className="relative">
          <button
            className="px-3 py-1.5 md:py-1 rounded bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 text-gray-800 dark:text-gray-200 text-sm md:text-base flex items-center"
            onClick={() => setDropdown(!dropdown)}
          >
            Opciones
            <ChevronDown size={16} className="ml-2" />
          </button>
          {dropdown && (
            <div className="absolute right-0 mt-2 w-[280px] md:w-[260px] bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded shadow-lg z-20 p-4">
              <div className="flex flex-col gap-4">
                {/* Opción Bot por opciones */}
                <div className="flex items-start justify-between p-3 rounded-lg border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors cursor-pointer"
                  onClick={() => handleOptionChange('options')}
                >
                  <div className="flex-1">
                    <div className="font-medium text-gray-800 dark:text-gray-200 text-sm">Bot por opciones</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">El usuario selecciona de opciones predefinidas</div>
                  </div>
                  <div className="flex items-center ml-3">
                    <input
                      type="radio"
                      name="botModality"
                      checked={botModality === 'options'}
                      onChange={() => {}}
                      className="w-4 h-4 text-blue-600 bg-gray-100 dark:bg-gray-700 border-gray-300 dark:border-gray-600 focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>

                {/* Opción Bot por palabras */}
                <div className="flex items-start justify-between p-3 rounded-lg border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors cursor-pointer"
                  onClick={() => handleOptionChange('words')}
                >
                  <div className="flex-1">
                    <div className="font-medium text-gray-800 dark:text-gray-200 text-sm">Bot por palabras</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">El usuario escribe palabras clave para interactuar</div>
                  </div>
                  <div className="flex items-center ml-3">
                    <input
                      type="radio"
                      name="botModality"
                      checked={botModality === 'words'}
                      onChange={() => {}}
                      className="w-4 h-4 text-blue-600 bg-gray-100 dark:bg-gray-700 border-gray-300 dark:border-gray-600 focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default BotModalitySection;
