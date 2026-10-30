import { useState, useEffect } from 'react';
import { X, Copy, Check } from 'lucide-react';
import type { ViewCredentialsModalProps } from '../../types/Station';

export function ViewCredentialsModal({ isOpen, onClose, station }: ViewCredentialsModalProps) {
  const [copied, setCopied] = useState<string | null>(null);
  const [credential, setCredential] = useState<{ email: string; password: string } | null>(null);

  useEffect(() => {
    if (isOpen && station) {
      // Obtener credenciales desde el backend si existen
      // Por ahora usamos los datos del station como email
      // La contraseña debe venir del backend en una respuesta especial
      setCredential({
        email: station.email,
        password: "••••••••••" // No se muestra por seguridad
      });
    } else {
      // Cleanup al cerrar
      setCopied(null);
      setCredential(null);
    }
  }, [isOpen, station]);

  if (!isOpen || !station || !credential) return null;

  const copyToClipboard = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopied(field);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-fade-in">
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full animate-scale-in">
        <div className="p-6 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-bold text-gray-900">Credenciales</h2>
            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded-xl hover:bg-gray-100 transition-colors"
            >
              <X className="w-5 h-5 text-gray-500" />
            </button>
          </div>
        </div>
        <div className="p-6 space-y-5">
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
            <p className="text-xs font-semibold text-blue-700 mb-2">ESTACIÓN</p>
            <p className="text-lg font-bold text-gray-900">{station.nombre}</p>
          </div>

          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">Email</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={credential.email}
                readOnly
                className="flex-1 px-4 py-3 bg-gray-50 border-2 border-gray-200 rounded-xl text-gray-700 font-mono text-sm"
              />
              <button
                type="button"
                onClick={() => copyToClipboard(credential.email, 'email')}
                className="p-3 bg-gray-100 hover:bg-gray-200 rounded-xl transition-colors"
              >
                {copied === 'email' ? (
                  <Check className="w-5 h-5 text-green-600" />
                ) : (
                  <Copy className="w-5 h-5 text-gray-600" />
                )}
              </button>
            </div>
          </div>

          <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4">
            <p className="text-xs font-semibold text-yellow-700">⚠️ ADVERTENCIA</p>
            <p className="text-xs text-yellow-700 mt-1">
              Estas credenciales son sensibles. Guárdalas de forma segura y no las compartas con personas no autorizadas.
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="w-full bg-gradient-to-r from-gray-100 to-gray-200 hover:from-gray-200 hover:to-gray-300 text-gray-800 py-3 rounded-xl font-semibold transition-all"
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}