import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';

interface AutoDownloadSectionProps {
  autoDownloadImagesFiles: boolean;
  autoDownloadDocuments: boolean;
  onImagesFilesChange: (value: boolean) => void;
  onDocumentsChange: (value: boolean) => void;
}

/**
 * Sección de configuración de descargas automáticas
 */
const AutoDownloadSection: React.FC<AutoDownloadSectionProps> = ({
  autoDownloadImagesFiles,
  autoDownloadDocuments,
  onImagesFilesChange,
  onDocumentsChange
}) => {
  const [dropdown, setDropdown] = useState(false);

  return (
    <div>
      <div className="flex flex-col md:flex-row md:items-center md:justify-between border-b border-gray-200 dark:border-gray-700 py-3 md:py-4 gap-3 md:gap-0">
        <div>
          <div className="text-gray-700 dark:text-gray-300 text-base md:text-lg">Descargas automáticas</div>
          <div className="text-xs md:text-sm text-gray-500 dark:text-gray-400">Controla qué tipos de archivos se descargan automáticamente</div>
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
              <div className="flex flex-col gap-4 mb-3">
                {/* Switch Imágenes / Archivos */}
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="font-medium text-gray-800 dark:text-gray-200 text-sm">Imágenes / Archivos</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">Fotos y archivos multimedia</div>
                  </div>
                  <div className="flex flex-col items-end gap-1 ml-3">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={autoDownloadImagesFiles}
                      onClick={() => onImagesFilesChange(!autoDownloadImagesFiles)}
                      className={`relative inline-flex items-center h-6 w-11 rounded-full transition-colors focus:outline-none ${autoDownloadImagesFiles ? 'bg-green-500 dark:bg-green-600' : 'bg-gray-200 dark:bg-gray-600'}`}
                    >
                      <span className={`transform transition-transform bg-white w-4 h-4 rounded-full shadow ${autoDownloadImagesFiles ? 'translate-x-5' : 'translate-x-1'}`} />
                    </button>
                    <span className="text-xs text-gray-600 dark:text-gray-400">{autoDownloadImagesFiles ? 'Activado' : 'Desactivado'}</span>
                  </div>
                </div>
                
                {/* Switch Documentos */}
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="font-medium text-gray-800 dark:text-gray-200 text-sm">Documentos</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">PDF, Word, hojas de cálculo</div>
                  </div>
                  <div className="flex flex-col items-end gap-1 ml-3">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={autoDownloadDocuments}
                      onClick={() => onDocumentsChange(!autoDownloadDocuments)}
                      className={`relative inline-flex items-center h-6 w-11 rounded-full transition-colors focus:outline-none ${autoDownloadDocuments ? 'bg-green-500 dark:bg-green-600' : 'bg-gray-200 dark:bg-gray-600'}`}
                    >
                      <span className={`transform transition-transform bg-white w-4 h-4 rounded-full shadow ${autoDownloadDocuments ? 'translate-x-5' : 'translate-x-1'}`} />
                    </button>
                    <span className="text-xs text-gray-600 dark:text-gray-400">{autoDownloadDocuments ? 'Activado' : 'Desactivado'}</span>
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

export default AutoDownloadSection;
