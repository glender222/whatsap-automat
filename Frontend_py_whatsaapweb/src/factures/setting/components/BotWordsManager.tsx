import React, { useState } from 'react';
import { Plus, Trash2, Bookmark, X } from 'lucide-react';

interface WordGroup {
  id: string;
  name: string;
  words: string[];
  tagId: string;
}

interface BotWordsManagerProps {
  availableTags: Array<{ id: string; name: string; color: string | null }>;
}

/**
 * Gestor de Bot por Palabras
 * Permite crear grupos de palabras clave asociadas a etiquetas
 */
const BotWordsManager: React.FC<BotWordsManagerProps> = ({ availableTags }) => {
  const [wordGroups, setWordGroups] = useState<WordGroup[]>([]);
  const [currentWord, setCurrentWord] = useState('');
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);

  const addWordGroup = () => {
    if (availableTags.length === 0) {
      alert('Primero debes crear etiquetas');
      return;
    }
    
    const newGroup: WordGroup = {
      id: `group-${Date.now()}`,
      name: '',
      words: [],
      tagId: availableTags[0].id
    };
    setWordGroups([...wordGroups, newGroup]);
    setEditingGroupId(newGroup.id);
  };

  const removeWordGroup = (id: string) => {
    setWordGroups(wordGroups.filter(g => g.id !== id));
    if (editingGroupId === id) {
      setEditingGroupId(null);
    }
  };

  const updateGroupName = (id: string, name: string) => {
    setWordGroups(wordGroups.map(g => g.id === id ? { ...g, name } : g));
  };

  const updateGroupTag = (id: string, tagId: string) => {
    setWordGroups(wordGroups.map(g => g.id === id ? { ...g, tagId } : g));
  };

  const addWordToGroup = (groupId: string) => {
    if (!currentWord.trim()) return;
    
    setWordGroups(wordGroups.map(g => 
      g.id === groupId 
        ? { ...g, words: [...g.words, currentWord.trim()] }
        : g
    ));
    setCurrentWord('');
  };

  const removeWordFromGroup = (groupId: string, wordIndex: number) => {
    setWordGroups(wordGroups.map(g => 
      g.id === groupId
        ? { ...g, words: g.words.filter((_, idx) => idx !== wordIndex) }
        : g
    ));
  };

  return (
    <div className="bg-gradient-to-br from-purple-50 to-indigo-50 rounded-lg p-6 border border-purple-200">
      <div className="bg-white rounded-lg shadow-sm p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">
          Chatbot Management - Bot por Palabras
        </h3>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Lado izquierdo: Grupos de Palabras */}
          <div className="space-y-4">
            {/* Info del Bot */}
            <div className="bg-gradient-to-r from-purple-50 to-purple-100 rounded-lg p-4 border border-purple-200">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-12 h-12 bg-purple-200 rounded-full flex items-center justify-center">
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
                Mensaje de bienvenida
              </label>
              <textarea
                placeholder="Escribe el mensaje inicial que verá el cliente..."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                rows={3}
                defaultValue="Hola, soy tu asistente virtual. Escribe una palabra clave para ayudarte."
              />
            </div>

            {/* Lista de Grupos de Palabras */}
            <div className="space-y-3">
              <label className="block text-sm font-medium text-gray-700">
                Grupos de Palabras Clave
              </label>
              
              {wordGroups.map((group) => {
                const tag = availableTags.find(t => t.id === group.tagId);
                return (
                  <div 
                    key={group.id} 
                    className={`bg-white border-2 rounded-lg p-4 cursor-pointer transition-all ${
                      editingGroupId === group.id 
                        ? 'border-purple-400 shadow-md' 
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                    onClick={() => setEditingGroupId(group.id)}
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex-1">
                        <input
                          type="text"
                          value={group.name}
                          onChange={(e) => updateGroupName(group.id, e.target.value)}
                          placeholder="Nombre del grupo"
                          className="w-full font-semibold text-gray-900 border-b border-transparent hover:border-gray-300 focus:border-purple-500 outline-none px-1 py-0.5"
                          onClick={(e) => e.stopPropagation()}
                        />
                        <div className="flex items-center gap-2 mt-2">
                          {tag && (
                            <>
                              <Bookmark 
                                size={14} 
                                style={{ color: tag.color || '#6B7280' }}
                                fill={tag.color || '#6B7280'}
                              />
                              <span className="text-xs text-gray-600">{tag.name}</span>
                            </>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removeWordGroup(group.id);
                        }}
                        className="p-1.5 text-red-500 hover:bg-red-50 rounded"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                    
                    {/* Palabras del grupo */}
                    <div className="flex flex-wrap gap-1 mt-2">
                      {group.words.length === 0 ? (
                        <span className="text-xs text-gray-400 italic">Sin palabras clave</span>
                      ) : (
                        group.words.map((word, idx) => (
                          <span 
                            key={idx}
                            className="inline-flex items-center gap-1 px-2 py-1 bg-purple-100 text-purple-700 text-xs rounded-full"
                          >
                            {word}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                removeWordFromGroup(group.id, idx);
                              }}
                              className="hover:bg-purple-200 rounded-full p-0.5"
                            >
                              <X size={12} />
                            </button>
                          </span>
                        ))
                      )}
                    </div>
                  </div>
                );
              })}

              <button
                onClick={addWordGroup}
                className="w-full py-3 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:border-purple-400 hover:text-purple-600 hover:bg-purple-50 transition-all flex items-center justify-center gap-2"
              >
                <Plus size={18} />
                <span className="font-medium">Agregar grupo de palabras</span>
              </button>
            </div>
          </div>

          {/* Lado derecho: Editor del Grupo Seleccionado */}
          <div className="space-y-4">
            {editingGroupId ? (
              <>
                <div className="bg-purple-50 rounded-lg p-4 border border-purple-200">
                  <h4 className="font-semibold text-gray-900 mb-3">
                    Editar Grupo: {wordGroups.find(g => g.id === editingGroupId)?.name || 'Sin nombre'}
                  </h4>
                  
                  {/* Selector de Etiqueta */}
                  <div className="mb-4">
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Etiqueta asociada
                    </label>
                    <select
                      value={wordGroups.find(g => g.id === editingGroupId)?.tagId || ''}
                      onChange={(e) => updateGroupTag(editingGroupId, e.target.value)}
                      className="w-full px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                    >
                      {availableTags.map(tag => (
                        <option key={tag.id} value={tag.id}>{tag.name}</option>
                      ))}
                    </select>
                  </div>

                  {/* Agregar Palabras */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Agregar palabra clave
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={currentWord}
                        onChange={(e) => setCurrentWord(e.target.value)}
                        onKeyPress={(e) => {
                          if (e.key === 'Enter') {
                            addWordToGroup(editingGroupId);
                          }
                        }}
                        placeholder="Escribe una palabra..."
                        className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                      />
                      <button
                        onClick={() => addWordToGroup(editingGroupId)}
                        className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors flex items-center gap-2"
                      >
                        <Plus size={16} />
                      </button>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      Presiona Enter o haz clic en + para agregar
                    </p>
                  </div>

                  {/* Lista de Palabras del Grupo */}
                  <div className="mt-4">
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Palabras en este grupo ({wordGroups.find(g => g.id === editingGroupId)?.words.length || 0})
                    </label>
                    <div className="bg-white rounded-lg p-3 border border-gray-200 min-h-[100px] max-h-[200px] overflow-y-auto">
                      <div className="flex flex-wrap gap-2">
                        {wordGroups.find(g => g.id === editingGroupId)?.words.map((word, idx) => (
                          <span 
                            key={idx}
                            className="inline-flex items-center gap-1 px-3 py-1.5 bg-purple-100 text-purple-700 text-sm rounded-full"
                          >
                            {word}
                            <button
                              onClick={() => removeWordFromGroup(editingGroupId, idx)}
                              className="hover:bg-purple-200 rounded-full p-0.5"
                            >
                              <X size={14} />
                            </button>
                          </span>
                        ))}
                        {(!wordGroups.find(g => g.id === editingGroupId)?.words.length) && (
                          <p className="text-sm text-gray-400 italic">No hay palabras agregadas</p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Vista Previa */}
                <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                  <h4 className="font-semibold text-gray-900 mb-3">Vista previa</h4>
                  <div className="bg-white rounded-lg p-4 border border-gray-300 space-y-3">
                    <p className="text-sm text-gray-700">
                      Hola, soy tu asistente virtual. Escribe una palabra clave para ayudarte.
                    </p>
                    <div className="text-xs text-gray-500 space-y-1">
                      <p className="font-medium">Palabras reconocidas:</p>
                      {wordGroups.map(group => (
                        <div key={group.id} className="pl-2">
                          <span className="font-semibold">{group.name || 'Grupo'}:</span>
                          {' '}
                          {group.words.join(', ') || '(sin palabras)'}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="bg-gray-50 rounded-lg p-8 border border-gray-200 flex flex-col items-center justify-center text-center h-full">
                <div className="w-16 h-16 bg-gray-200 rounded-full flex items-center justify-center mb-4">
                  <span className="text-3xl">📝</span>
                </div>
                <p className="text-gray-600 font-medium mb-2">
                  Selecciona un grupo para editar
                </p>
                <p className="text-sm text-gray-500">
                  Haz clic en un grupo de palabras o crea uno nuevo
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default BotWordsManager;
