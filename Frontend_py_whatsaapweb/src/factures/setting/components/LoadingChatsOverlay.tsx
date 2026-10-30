import React from 'react';
import { MessageSquare, CheckCircle2, Loader2 } from 'lucide-react';

interface LoadingChatsOverlayProps {
  status: 'idle' | 'started' | 'fetching' | 'processing' | 'initial-loaded' | 'loading' | 'completed' | 'error';
  loaded?: number;
  total?: number;
  percentage?: number;
  message?: string;
}

const LoadingChatsOverlay: React.FC<LoadingChatsOverlayProps> = ({ 
  status, 
  loaded = 0, 
  total = 0, 
  percentage = 0,
  message 
}) => {
  const isCompleted = status === 'completed';
  const isFetching = status === 'fetching' || status === 'processing' || status === 'started';
  const actualPercentage = percentage || (total > 0 ? Math.round((loaded / total) * 100) : 0);

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-gradient-to-br from-blue-50 via-white to-green-50">
      <div className="flex flex-col items-center gap-6 px-6 py-8 max-w-md w-full">
        {/* Icono animado */}
        <div className="relative">
          {isCompleted ? (
            <div className="animate-scale-in">
              <CheckCircle2 size={80} className="text-green-500" />
            </div>
          ) : isFetching ? (
            // Estado inicial: solo spinner sin progreso
            <div className="relative">
              <Loader2 size={80} className="text-blue-600 animate-spin" />
            </div>
          ) : (
            // Estado de carga: con progreso
            <>
              <MessageSquare size={80} className="text-blue-600 animate-pulse" />
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-24 h-24 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin"></div>
              </div>
            </>
          )}
        </div>

        {/* Título y mensaje */}
        <div className="text-center">
          <h2 className="text-2xl font-bold text-gray-900 mb-2">
            {isCompleted ? '¡Listo!' : 'Cargando chats...'}
          </h2>
          <p className="text-gray-600 text-sm">
            {message || (isCompleted ? 'Todos los chats han sido cargados' : 'Estamos sincronizando tus conversaciones')}
          </p>
        </div>

        {/* Barra de progreso - solo si hay total definido */}
        {!isCompleted && !isFetching && total > 0 && (
          <div className="w-full">
            <div className="flex justify-between text-sm text-gray-600 mb-2">
              <span>{loaded} de {total}</span>
              <span>{actualPercentage}%</span>
            </div>
            <div className="w-full h-3 bg-gray-200 rounded-full overflow-hidden">
              <div 
                className="h-full bg-gradient-to-r from-blue-500 to-green-500 transition-all duration-500 ease-out rounded-full"
                style={{ width: `${actualPercentage}%` }}
              />
            </div>
          </div>
        )}

        {/* Mensaje de estado con indicadores de fase */}
        {status === 'started' && (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
            <span>Iniciando sincronización con WhatsApp...</span>
          </div>
        )}

        {status === 'fetching' && (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
            <span>📡 Obteniendo lista de chats...</span>
          </div>
        )}

        {status === 'processing' && (
          <div className="flex items-center gap-2 text-sm text-blue-600">
            <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
            <span>📦 Procesando {total} chats...</span>
          </div>
        )}

        {status === 'initial-loaded' && (
          <div className="flex flex-col items-center gap-2">
            <div className="flex items-center gap-2 text-sm text-green-600">
              <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
              <span>⚡ Primeros chats listos - Ya puedes navegar</span>
            </div>
            {actualPercentage < 100 && (
              <div className="text-xs text-gray-500">
                Cargando previews en segundo plano...
              </div>
            )}
          </div>
        )}

        {status === 'loading' && (
          <div className="flex flex-col items-center gap-2">
            <div className="flex items-center gap-2 text-sm text-blue-600">
              <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
              <span>📦 Cargando más conversaciones...</span>
            </div>
            <div className="text-xs text-gray-500">
              Puedes empezar a usar la app mientras termina
            </div>
          </div>
        )}

        {isCompleted && (
          <button
            onClick={() => window.location.href = '/mensajeria'}
            className="mt-4 px-6 py-3 bg-gradient-to-r from-blue-600 to-green-600 text-white font-semibold rounded-lg hover:from-blue-700 hover:to-green-700 transition-all duration-300 shadow-lg hover:shadow-xl transform hover:scale-105"
          >
            Ir a mis chats
          </button>
        )}
      </div>
    </div>
  );
};

export default LoadingChatsOverlay;
