import React from 'react';
import { ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

const BotSettingsPage: React.FC = () => {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-4 md:px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center gap-3">
          <button
            onClick={() => navigate(-1)}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
            aria-label="Volver"
          >
            <ArrowLeft className="w-5 h-5 text-gray-600" />
          </button>
          <h1 className="text-lg md:text-2xl font-semibold text-gray-900">
            Configuración del Bot
          </h1>
        </div>
      </div>

      {/* Contenido principal */}
      <div className="max-w-6xl mx-auto px-4 md:px-6 py-8">
        <div className="bg-white rounded-lg shadow-sm p-6 md:p-8">
          <div className="flex flex-col gap-8">
            {/* Placeholder para las configuraciones del Bot */}
            <div className="text-center py-12">
              <div className="text-gray-400 text-lg">
                Las configuraciones del Bot estarán disponibles pronto
              </div>
              <p className="text-gray-500 text-sm mt-2">
                Aquí podrás configurar el comportamiento y respuestas automáticas del bot
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default BotSettingsPage;
