import React, { useState } from 'react';
import { Plus, Trash2, ChevronDown, ChevronUp, Bookmark } from 'lucide-react';

interface BotOption {
  id: string;
  order: number;
  name: string;
  tagId: string | null;
}

interface BotOptionsManagerProps {
  availableTags: Array<{ id: string; name: string; color: string | null }>;
}

/**
 * Gestor de Bot por Opciones
 * Permite crear un flujo de opciones numeradas asociadas a etiquetas
 */
const BotOptionsManager: React.FC<BotOptionsManagerProps> = ({ availableTags }) => {
  const [options, setOptions] = useState<BotOption[]>([]);
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);

  const addOption = () => {
    const newOption: BotOption = {
      id: `opt-${Date.now()}`,
      order: options.length + 1,
      name: '',
      tagId: availableTags.length > 0 ? availableTags[0].id : null
    };
    setOptions([...options, newOption]);
    setSelectedOptionId(newOption.id);
  };

  const removeOption = (id: string) => {
    const filtered = options.filter(opt => opt.id !== id);
    // Reordenar
    const reordered = filtered.map((opt, idx) => ({ ...opt, order: idx + 1 }));
    setOptions(reordered);
    if (selectedOptionId === id) {
      setSelectedOptionId(null);
    }
  };

  const updateOptionName = (id: string, name: string) => {
    setOptions(options.map(opt => opt.id === id ? { ...opt, name } : opt));
  };

  const updateOptionTag = (id: string, tagId: string) => {
    setOptions(options.map(opt => opt.id === id ? { ...opt, tagId } : opt));
  };

  const moveOption = (id: string, direction: 'up' | 'down') => {
    const index = options.findIndex(opt => opt.id === id);
    if (index === -1) return;
    
    if (direction === 'up' && index > 0) {
      const newOptions = [...options];
      [newOptions[index - 1], newOptions[index]] = [newOptions[index], newOptions[index - 1]];
      // Actualizar order
      newOptions.forEach((opt, idx) => opt.order = idx + 1);
      setOptions(newOptions);
    } else if (direction === 'down' && index < options.length - 1) {
      const newOptions = [...options];
      [newOptions[index], newOptions[index + 1]] = [newOptions[index + 1], newOptions[index]];
      // Actualizar order
      newOptions.forEach((opt, idx) => opt.order = idx + 1);
      setOptions(newOptions);
    }
  };

  return (
    <div className="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-lg p-6 border border-blue-200">
      <div className="bg-white rounded-lg shadow-sm p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">
          Chatbot Management - Bot por Opciones
        </h3>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Lado izquierdo: Configuración del Bot */}
          <div className="space-y-4">
            {/* Info del Bot */}
            <div className="bg-gradient-to-r from-blue-50 to-blue-100 rounded-lg p-4 border border-blue-200">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-12 h-12 bg-blue-200 rounded-full flex items-center justify-center">
                  <span className="text-2xl">🤖</span>
                </div>
                <div>
                  <h4 className="font-semibold text-gray-900">Mi bot</h4>
                  <p className="text-sm text-gray-600">Número afiliado: 925593795</p>
                </div>
              </div>
              <span className="inline-block px-3 py-1 bg-green-100 text-green-700 text-xs font-medium rounded-full">
                Active
              </span>
            </div>

            {/* Mensaje del Cliente */}
            <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Estimado cliente seleccione servicio
              </label>
              <textarea
                placeholder="Escribe el mensaje inicial que verá el cliente..."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                rows={3}
                defaultValue="Estimado cliente seleccione servicio"
              />
            </div>

            {/* Lista de Opciones */}
            <div className="space-y-2 max-h-[400px] overflow-y-auto pr-2">
              {options.map((option, index) => {
                const tag = availableTags.find(t => t.id === option.tagId);
                return (
                  <div 
                    key={option.id} 
                    className={`bg-white border-2 rounded-lg p-3 shadow-sm cursor-pointer transition-all ${
                      selectedOptionId === option.id 
                        ? 'border-blue-400 shadow-md' 
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                    onClick={() => setSelectedOptionId(option.id)}
                  >
                    <div className="flex items-center gap-2">
                      <div className="flex flex-col gap-1">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            moveOption(option.id, 'up');
                          }}
                          disabled={index === 0}
                          className="p-1 hover:bg-gray-100 rounded disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          <ChevronUp size={14} />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            moveOption(option.id, 'down');
                          }}
                          disabled={index === options.length - 1}
                          className="p-1 hover:bg-gray-100 rounded disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          <ChevronDown size={14} />
                        </button>
                      </div>
                      
                      <span className="font-semibold text-gray-700 min-w-[20px]">{option.order}</span>
                      
                      <div className="flex-1 min-w-0">
                        <input
                          type="text"
                          value={option.name}
                          onChange={(e) => updateOptionName(option.id, e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          placeholder="Nombre de la opción"
                          className="w-full px-3 py-1.5 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                        {tag && (
                          <div className="flex items-center gap-1 mt-1">
                            <Bookmark 
                              size={12} 
                              style={{ color: tag.color || '#6B7280' }}
                              fill={tag.color || '#6B7280'}
                            />
                            <span className="text-xs text-gray-600">{tag.name}</span>
                          </div>
                        )}
                      </div>

                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removeOption(option.id);
                        }}
                        className="p-1.5 text-red-500 hover:bg-red-50 rounded"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                );
              })}

              <button
                onClick={addOption}
                className="w-full py-2.5 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:border-blue-400 hover:text-blue-600 hover:bg-blue-50 transition-all flex items-center justify-center gap-2"
              >
                <Plus size={18} />
                <span className="font-medium">Agregar opción</span>
              </button>
            </div>
          </div>

          {/* Lado derecho: Editor de Opción Seleccionada */}
          <div className="space-y-4">
            {selectedOptionId ? (
              <>
                {/* Etiqueta Asociada Actual */}
                {(() => {
                  const currentTag = availableTags.find(t => t.id === options.find(o => o.id === selectedOptionId)?.tagId);
                  return (
                    <div className="bg-blue-50 rounded-lg p-4 border border-blue-200">
                      <h4 className="font-semibold text-gray-900 mb-3">
                        Opción: {options.find(o => o.id === selectedOptionId)?.order}. {options.find(o => o.id === selectedOptionId)?.name || 'Sin nombre'}
                      </h4>
                      
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Etiqueta asociada
                      </label>
                      
                      {currentTag ? (
                        <div className="flex items-center justify-between px-3 py-2 bg-white border-2 border-blue-300 rounded-lg text-sm">
                          <div className="flex items-center gap-2">
                            <Bookmark 
                              size={16} 
                              style={{ color: currentTag.color || '#6B7280' }}
                              fill={currentTag.color || '#6B7280'}
                            />
                            <span className="font-medium">{currentTag.name}</span>
                          </div>
                          <button
                            onClick={() => updateOptionTag(selectedOptionId, '')}
                            className="text-xs text-red-500 hover:text-red-700 font-medium"
                          >
                            Quitar
                          </button>
                        </div>
                      ) : (
                        <div className="px-3 py-2 bg-white border-2 border-dashed border-gray-300 rounded-lg text-sm text-gray-500 italic">
                          Sin etiqueta asociada
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* Etiquetas Disponibles para Asociar */}
                {(() => {
                  // Obtener IDs de etiquetas ya asociadas
                  const associatedTagIds = options
                    .filter(opt => opt.tagId)
                    .map(opt => opt.tagId);
                  
                  // Filtrar etiquetas no asociadas
                  const availableToAssociate = availableTags.filter(
                    tag => !associatedTagIds.includes(tag.id)
                  );

                  return (
                    <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                      <h4 className="font-semibold text-gray-900 mb-3">Asociados</h4>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Etiquetas disponibles (clic para asociar)
                      </label>
                      <div className="space-y-1 max-h-[300px] overflow-y-auto">
                        {availableToAssociate.length > 0 ? (
                          availableToAssociate.map(tag => (
                            <button
                              key={tag.id}
                              onClick={() => updateOptionTag(selectedOptionId, tag.id)}
                              className="w-full flex items-center justify-between px-3 py-2 bg-white border border-gray-200 rounded text-sm hover:border-blue-400 hover:bg-blue-50 transition-all"
                            >
                              <span>{tag.name}</span>
                              <Bookmark 
                                size={14} 
                                style={{ color: tag.color || '#6B7280' }}
                                fill={tag.color || '#6B7280'}
                              />
                            </button>
                          ))
                        ) : (
                          <p className="text-xs text-gray-400 italic px-3 py-2">
                            Todas las etiquetas están asociadas
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })()}
                

                {/* Vista Previa */}
                <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                  <h4 className="font-semibold text-gray-900 mb-3">Vista previa</h4>
                  <div className="bg-white rounded-lg p-4 border border-gray-300 space-y-2">
                    <p className="text-sm text-gray-700 mb-3">Estimado cliente seleccione servicio</p>
                    {options.map((option) => (
                      <div key={option.id} className="text-sm text-gray-700">
                        {option.order}. {option.name || '(Sin nombre)'}
                      </div>
                    ))}
                    {options.length === 0 && (
                      <p className="text-xs text-gray-400 italic">No hay opciones configuradas</p>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <div className="bg-gray-50 rounded-lg p-8 border border-gray-200 flex flex-col items-center justify-center text-center h-full">
                <div className="w-16 h-16 bg-gray-200 rounded-full flex items-center justify-center mb-4">
                  <span className="text-3xl">📝</span>
                </div>
                <p className="text-gray-600 font-medium mb-2">
                  Selecciona una opción para editar
                </p>
                <p className="text-sm text-gray-500">
                  Haz clic en una opción o crea una nueva
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default BotOptionsManager;
