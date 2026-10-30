import React from 'react';
// ...existing code...

interface Filter {
  name: string;
  count: number;
}

// ...existing code...

interface LocalTopbarProps {
  filters: Filter[];
  selectedFilter: string;
  setSelectedFilter: (v: string) => void;
  onReloadChats?: () => void;
}

const LocalTopbar: React.FC<LocalTopbarProps> = ({
  filters,
  selectedFilter,
  setSelectedFilter,
  onReloadChats,
}) => (
  <div className="w-full bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-6 py-4 h-16 flex items-center justify-between transition-colors duration-300 z-10 flex-shrink-0">
    <div className="flex items-center">
      <span
        className="text-2xl font-extrabold tracking-wide"
        style={{
          color: '#23c16b',
          fontFamily: '"Montserrat", "Segoe UI", "Arial", sans-serif',
          letterSpacing: '2px',
          textShadow: '0 1px 5px rgba(35,193,107,0.10)',
          userSelect: 'none'
        }}
      >
        GestionWeb
      </span>
    </div>
    <div className="flex gap-2 items-center">
      {/* Botones de filtro - Ocultos en móvil */}
      {filters.map((filter) => (
        <button
          key={filter.name}
          onClick={() => setSelectedFilter(filter.name)}
          className={`hidden md:flex px-3 py-1.5 text-sm rounded border transition-colors items-center font-medium ${selectedFilter === filter.name
            ? filter.name === 'Completo'
              ? 'bg-green-50 dark:bg-green-900/30 border-green-200 dark:border-green-700 text-green-700 dark:text-green-300'
              : 'bg-yellow-50 dark:bg-yellow-900/30 border-yellow-200 dark:border-yellow-700 text-yellow-700 dark:text-yellow-300'
            : 'bg-gray-50 dark:bg-gray-700 border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600'
            }`}
        >
          {filter.name}
          <span className="mx-2 px-2 py-0.5 border border-gray-300 dark:border-gray-600 rounded text-xs bg-white dark:bg-gray-800">{filter.count}</span>
        </button>
      ))}
      {/* Botón de recarga de chats */}
      {onReloadChats && (
        <button 
          onClick={onReloadChats}
          className="ml-2 p-2 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
          title="Recargar chats desde el servidor"
        >
          <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      )}
      <button className="ml-2 p-2 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
        <svg width="16" height="16" fill="none" stroke="currentColor">
          <path d="M13.5 2.5l-1-1a1 1 0 0 0-1.4 0l-7.6 7.6a1 1 0 0 0-.3.6l-.4 2.5a1 1 0 0 0 1.1 1.1l2.5-.4a1 1 0 0 0 .6-.3l7.6-7.6a1 1 0 0 0 0-1.4z" strokeWidth="1.5" />
        </svg>
      </button>
    </div>
  </div>
);

export default LocalTopbar;