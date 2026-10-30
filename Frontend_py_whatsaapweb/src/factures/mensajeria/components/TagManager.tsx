import React, { useState } from 'react';
import { X, Trash2, Edit2 } from 'lucide-react';
import type { Tag } from '../types/tagTypes';

interface TagManagerProps {
  open: boolean;
  onClose: () => void;
  tags: Tag[];
  onCreateTag?: (data: { name: string; color: string }) => Promise<void>;
  onUpdateTag?: (id: string, data: { name: string; color: string }) => Promise<void>;
  onDeleteTag?: (id: string) => Promise<void>;
  loading?: boolean;
}

// Paleta de colores predefinidos con relleno
const COLOR_PALETTE = [
  { label: 'Verde', class: 'text-green-500', bg: 'bg-green-500', border: 'border-green-200' },
  { label: 'Púrpura', class: 'text-purple-500', bg: 'bg-purple-500', border: 'border-purple-200' },
  { label: 'Rojo', class: 'text-red-500', bg: 'bg-red-500', border: 'border-red-200' },
  { label: 'Amarillo', class: 'text-yellow-500', bg: 'bg-yellow-500', border: 'border-yellow-200' },
  { label: 'Azul', class: 'text-blue-500', bg: 'bg-blue-500', border: 'border-blue-200' },
  { label: 'Rosa', class: 'text-pink-500', bg: 'bg-pink-500', border: 'border-pink-200' },
  { label: 'Índigo', class: 'text-indigo-500', bg: 'bg-indigo-500', border: 'border-indigo-200' },
  { label: 'Cyan', class: 'text-cyan-500', bg: 'bg-cyan-500', border: 'border-cyan-200' },
];

function colorSwatchClass(color?: string | null): string {
  if (!color) return 'bg-gray-400';
  if (color.startsWith('bg-')) return color;
  if (color.startsWith('text-')) return color.replace(/^text-/, 'bg-');
  return '';
}

function colorSwatchStyle(color?: string | null): React.CSSProperties | undefined {
  return color && color.startsWith('#') ? { backgroundColor: color } : undefined;
}

interface EditingState {
  tagId: string | null;
  name: string;
  color: string;
}

const TagManager: React.FC<TagManagerProps> = ({
  open,
  onClose,
  tags,
  onCreateTag,
  onUpdateTag,
  onDeleteTag,
}) => {
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState('text-green-500');
  const [editingState, setEditingState] = useState<EditingState>({ tagId: null, name: '', color: '' });
  const [error, setError] = useState('');
  const [operationLoading, setOperationLoading] = useState(false);

  const resetForm = () => {
    setNewTagName('');
    setNewTagColor('text-green-500');
    setError('');
  };

  const handleCreateTag = async () => {
    setError('');
    if (!newTagName.trim()) {
      setError('El nombre es obligatorio');
      return;
    }

    if (!onCreateTag) return;

    setOperationLoading(true);
    try {
      await onCreateTag({ name: newTagName.trim(), color: newTagColor });
      resetForm();
    } catch (err: any) {
      setError(err?.message || 'Error al crear la etiqueta');
    } finally {
      setOperationLoading(false);
    }
  };

  const handleUpdateTag = async () => {
    setError('');
    if (!editingState.tagId) return;
    if (!editingState.name.trim()) {
      setError('El nombre es obligatorio');
      return;
    }

    if (!onUpdateTag) return;

    setOperationLoading(true);
    try {
      await onUpdateTag(editingState.tagId, {
        name: editingState.name.trim(),
        color: editingState.color,
      });
      setEditingState({ tagId: null, name: '', color: '' });
    } catch (err: any) {
      setError(err?.message || 'Error al actualizar la etiqueta');
    } finally {
      setOperationLoading(false);
    }
  };

  const handleDeleteTag = async (tagId: string) => {
    if (!onDeleteTag) return;

    // Proteger el tag "Todo" de eliminación
    const tagToDelete = tags.find(t => t.id === tagId);
    if (tagToDelete?.name === 'Todo') {
      setError('No puedes eliminar la etiqueta "Todo"');
      return;
    }

    if (!confirm('¿Estás seguro de que deseas eliminar esta etiqueta?')) return;

    setOperationLoading(true);
    try {
      await onDeleteTag(tagId);
    } catch (err: any) {
      setError(err?.message || 'Error al eliminar la etiqueta');
    } finally {
      setOperationLoading(false);
    }
  };

  const startEditing = (tag: Tag) => {
    setEditingState({
      tagId: tag.id,
      name: tag.name,
      color: tag.color ?? 'text-green-500',
    });
    setError('');
  };

  const cancelEditing = () => {
    setEditingState({ tagId: null, name: '', color: '' });
    setError('');
  };

  if (!open) return null;

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 bg-black bg-opacity-40 z-40 transition-opacity duration-200"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="fixed inset-0 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-lg shadow-2xl max-w-md w-full transform transition-all duration-200 scale-100 opacity-100 max-h-[90vh] overflow-y-auto">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 sticky top-0 bg-white">
            <h2 className="text-lg font-semibold text-gray-900">Gestionar etiquetas</h2>
            <button
              onClick={onClose}
              disabled={operationLoading}
              className="p-1 rounded-md hover:bg-gray-100 transition-colors disabled:opacity-50"
              aria-label="Cerrar"
            >
              <X size={20} className="text-gray-600" />
            </button>
          </div>

          {/* Body */}
          <div className="p-6 space-y-6">
            {/* Sección: Nueva etiqueta */}
            <div className="border-b border-gray-200 pb-6">
              <h3 className="text-sm font-semibold text-gray-700 mb-4">Nueva etiqueta</h3>

              <div className="space-y-4">
                {/* Input de nombre */}
                <input
                  type="text"
                  value={newTagName}
                  onChange={(e) => setNewTagName(e.target.value)}
                  placeholder="Ej. Copias, Banners..."
                  disabled={operationLoading}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all disabled:opacity-50 disabled:bg-gray-50 text-sm"
                />

                {/* Selector de color */}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-2">Color</label>
                  <div className="grid grid-cols-4 gap-2">
                    {COLOR_PALETTE.map((color) => (
                      <button
                        key={color.class}
                        type="button"
                        onClick={() => setNewTagColor(color.class)}
                        disabled={operationLoading}
                        className={`
                          relative p-3 rounded-lg border-2 transition-all disabled:opacity-50
                          ${newTagColor === color.class
                            ? `border-blue-500 ring-2 ring-offset-2 ring-blue-300`
                            : 'border-gray-300'
                          }
                        `}
                        title={color.label}
                      >
                        <div className={`w-8 h-8 rounded-full ${color.bg} flex items-center justify-center`}>
                          {newTagColor === color.class && (
                            <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                            </svg>
                          )}
                        </div>
                        <span className="text-xs text-gray-700 block mt-1 text-center font-medium">{color.label}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Botón crear */}
                <button
                  onClick={handleCreateTag}
                  disabled={operationLoading || !newTagName.trim()}
                  className="w-full px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {operationLoading ? 'Creando...' : 'Crear etiqueta'}
                </button>
              </div>
            </div>

            {/* Sección: Etiquetas existentes */}
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Etiquetas ({tags.length})</h3>

                  {tags.length === 0 ? (
                    <p className="text-sm text-gray-500 text-center py-6">No hay etiquetas aún</p>
                  ) : (
                    <div className="space-y-2">
                      {tags.map((tag) => {
                        const isEditing = editingState.tagId === tag.id;
                        const isProtected = tag.name === 'Todo';

                        return (
                      <div key={tag.id} className="border border-gray-200 rounded-lg p-3 transition-all">
                        {!isEditing ? (
                          // Vista normal
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 flex-1">
                              <div
                                className={`w-4 h-4 rounded-full ${colorSwatchClass(tag.color)}`}
                                style={colorSwatchStyle(tag.color)}
                              />
                              <span className="text-sm font-medium text-gray-800">{tag.name}</span>
                              {isProtected && (
                                <span className="text-xs bg-yellow-50 text-yellow-700 px-2 py-0.5 rounded border border-yellow-200">Sistema</span>
                              )}
                            </div>
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => startEditing(tag)}
                                disabled={operationLoading || isProtected}
                                className="p-1.5 rounded-md hover:bg-blue-50 text-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                title={isProtected ? 'No se puede editar' : 'Editar'}
                              >
                                <Edit2 size={16} />
                              </button>
                              <button
                                onClick={() => handleDeleteTag(tag.id)}
                                disabled={operationLoading || isProtected}
                                className="p-1.5 rounded-md hover:bg-red-50 text-red-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                title={isProtected ? 'No se puede eliminar' : 'Eliminar'}
                              >
                                <Trash2 size={16} />
                              </button>
                            </div>
                          </div>
                        ) : (
                          // Vista de edición
                          <div className="space-y-3">
                            {/* Input nombre editable */}
                            <input
                              type="text"
                              value={editingState.name}
                              onChange={(e) => setEditingState((prev) => ({ ...prev, name: e.target.value }))}
                              disabled={operationLoading}
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all disabled:opacity-50 disabled:bg-gray-50 text-sm"
                              autoFocus
                            />

                            {/* Selector de color */}
                            <div className="grid grid-cols-4 gap-2">
                              {COLOR_PALETTE.map((color) => (
                                <button
                                  key={color.class}
                                  type="button"
                                  onClick={() => setEditingState((prev) => ({ ...prev, color: color.class }))}
                                  disabled={operationLoading}
                                  className={`
                                    relative p-3 rounded-lg border-2 transition-all disabled:opacity-50
                                    ${editingState.color === color.class
                                      ? `border-blue-500 ring-2 ring-offset-2 ring-blue-300`
                                      : 'border-gray-300'
                                    }
                                  `}
                                  title={color.label}
                                >
                                  <div className={`w-8 h-8 rounded-full ${color.bg} flex items-center justify-center`}>
                                    {editingState.color === color.class && (
                                      <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 20 20">
                                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                                      </svg>
                                    )}
                                  </div>
                                  <span className="text-xs text-gray-700 block mt-1 text-center font-medium">{color.label}</span>
                                </button>
                              ))}
                            </div>

                            {/* Botones de guardar/cancelar */}
                            <div className="flex gap-2">
                              <button
                                onClick={handleUpdateTag}
                                disabled={operationLoading || !editingState.name.trim()}
                                className="flex-1 px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                {operationLoading ? 'Guardando...' : 'Guardar'}
                              </button>
                              <button
                                onClick={cancelEditing}
                                disabled={operationLoading}
                                className="flex-1 px-3 py-1.5 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors disabled:opacity-50"
                              >
                                Cancelar
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Mensaje de error */}
            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
                <p className="text-sm text-red-700">{error}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
};

export default TagManager;
