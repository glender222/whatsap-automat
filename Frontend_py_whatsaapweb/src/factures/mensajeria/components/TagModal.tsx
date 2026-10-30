import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import type { Tag } from '../types/tagTypes';

interface TagModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: { name: string; color: string }) => void;
  tag?: Tag | null;
  loading?: boolean;
}

// Paleta de colores predefinidos (clases tailwind + labels)
const COLOR_PALETTE = [
  { label: 'Verde', class: 'text-green-500', bg: 'bg-green-50', border: 'border-green-200' },
  { label: 'Púrpura', class: 'text-purple-500', bg: 'bg-purple-50', border: 'border-purple-200' },
  { label: 'Rojo', class: 'text-red-500', bg: 'bg-red-50', border: 'border-red-200' },
  { label: 'Amarillo', class: 'text-yellow-500', bg: 'bg-yellow-50', border: 'border-yellow-200' },
  { label: 'Azul', class: 'text-blue-500', bg: 'bg-blue-50', border: 'border-blue-200' },
  { label: 'Rosa', class: 'text-pink-500', bg: 'bg-pink-50', border: 'border-pink-200' },
  { label: 'Índigo', class: 'text-indigo-500', bg: 'bg-indigo-50', border: 'border-indigo-200' },
  { label: 'Cyan', class: 'text-cyan-500', bg: 'bg-cyan-50', border: 'border-cyan-200' },
];

const TagModal: React.FC<TagModalProps> = ({ open, onClose, onSubmit, tag, loading = false }) => {
  const [name, setName] = useState('');
  const [selectedColor, setSelectedColor] = useState('text-green-500');
  const [error, setError] = useState('');

  // Reset form cuando se abre o cuando cambia `tag`
  useEffect(() => {
    if (open) {
      if (tag) {
        setName(tag.name);
        setSelectedColor(tag.color ?? 'text-green-500');
      } else {
        setName('');
        setSelectedColor('text-green-500');
      }
      setError('');
    }
  }, [open, tag]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!name.trim()) {
      setError('El nombre de la etiqueta es obligatorio');
      return;
    }

    onSubmit({
      name: name.trim(),
      color: selectedColor,
    });

    // No limpiar aquí, dejar que onClose maneje eso
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
        <div className="bg-white rounded-lg shadow-2xl max-w-md w-full transform transition-all duration-200 scale-100 opacity-100">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900">
              {tag ? 'Editar etiqueta' : 'Nueva etiqueta'}
            </h2>
            <button
              onClick={onClose}
              disabled={loading}
              className="p-1 rounded-md hover:bg-gray-100 transition-colors disabled:opacity-50"
              aria-label="Cerrar"
            >
              <X size={20} className="text-gray-600" />
            </button>
          </div>

          {/* Body */}
          <form onSubmit={handleSubmit} className="p-6 space-y-5">
            {/* Input de nombre */}
            <div>
              <label htmlFor="tag-name" className="block text-sm font-medium text-gray-700 mb-2">
                Nombre de la etiqueta
              </label>
              <input
                id="tag-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ej. Copias, Banners..."
                disabled={loading}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all disabled:opacity-50 disabled:bg-gray-50"
                autoFocus
              />
            </div>

            {/* Selector de color */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-3">Color</label>
              <div className="grid grid-cols-4 gap-3">
                {COLOR_PALETTE.map((color) => (
                  <button
                    key={color.class}
                    type="button"
                    onClick={() => setSelectedColor(color.class)}
                    disabled={loading}
                    className={`
                      relative p-3 rounded-lg border-2 transition-all disabled:opacity-50
                      ${selectedColor === color.class
                        ? `${color.border} border-2 ring-2 ring-offset-2 ring-blue-300`
                        : 'border-gray-200 hover:border-gray-300'
                      }
                    `}
                    title={color.label}
                  >
                    <div className={`w-6 h-6 rounded-full ${color.class} flex items-center justify-center`}>
                      {selectedColor === color.class && (
                        <svg
                          className="w-4 h-4 text-current"
                          fill="currentColor"
                          viewBox="0 0 20 20"
                        >
                          <path
                            fillRule="evenodd"
                            d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                            clipRule="evenodd"
                          />
                        </svg>
                      )}
                    </div>
                    <span className="text-xs text-gray-600 block mt-2 text-center font-medium">
                      {color.label}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* Mensaje de error */}
            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
                <p className="text-sm text-red-700">{error}</p>
              </div>
            )}

            {/* Buttons */}
            <div className="flex gap-3 pt-4 border-t border-gray-200">
              <button
                type="button"
                onClick={onClose}
                disabled={loading}
                className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={loading}
                className="flex-1 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
              >
                {loading ? 'Guardando...' : tag ? 'Actualizar' : 'Crear'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
};

export default TagModal;
