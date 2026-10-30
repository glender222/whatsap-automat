import { useState } from 'react';
import { X, Eye, EyeOff, Check } from 'lucide-react';
import type { ChangePasswordModalProps, PasswordStrength } from '../../types/Station';

export function ChangePasswordModal({ isOpen, onClose, station, onSave }: ChangePasswordModalProps) {
  const [newPassword, setNewPassword] = useState<string>('');
  const [confirmPassword, setConfirmPassword] = useState<string>('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passwordStrength, setPasswordStrength] = useState<PasswordStrength>({
    length: false,
    hasNumber: false,
    hasSpecial: false,
  });

  const isPasswordStrong = Object.values(passwordStrength).every(Boolean);
  const passwordsMatch = newPassword === confirmPassword && confirmPassword !== '';

  const handlePasswordChange = (password: string) => {
    setNewPassword(password);
    setPasswordStrength({
      length: password.length >= 8,
      hasNumber: /\d/.test(password),
      hasSpecial: /[!@#$%^&*(),.?":{}|<>]/.test(password),
    });
  };

  if (!isOpen || !station) return null;

  const handleSubmit = async () => {
    if (!newPassword || !confirmPassword) {
      setError('Todos los campos son requeridos');
      return;
    }

    if (!isPasswordStrong) {
      setError('La contraseña no cumple con los requisitos de seguridad');
      return;
    }

    if (!passwordsMatch) {
      setError('Las contraseñas no coinciden');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await onSave(station.id, newPassword);
      // Al cerrar el modal desde el componente padre se resetea todo automáticamente
    } catch (err: any) {
      setError(err?.message || 'Error al cambiar contraseña');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-fade-in">
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full animate-scale-in max-h-[90vh] overflow-y-auto">
        <div className="p-6 border-b border-gray-200 sticky top-0 bg-white">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-bold text-gray-900">Cambiar contraseña</h2>
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
            <p className="text-sm font-semibold text-blue-900">{station.nombre}</p>
          </div>

          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">
              Nueva contraseña
            </label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={newPassword}
                onChange={(e) => handlePasswordChange(e.target.value)}
                placeholder="Ingresa la nueva contraseña"
                className="w-full px-4 py-3 pr-10 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-blue-500 transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-500 hover:text-gray-700"
              >
                {showPassword ? (
                  <Eye className="w-5 h-5" />
                ) : (
                  <EyeOff className="w-5 h-5" />
                )}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">
              Confirmar contraseña
            </label>
            <input
              type={showPassword ? 'text' : 'password'}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirma la nueva contraseña"
              className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-blue-500 transition-colors"
            />
          </div>

          {/* Indicador de seguridad de contraseña */}
          {newPassword && (
            <div className="space-y-2">
              <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all duration-300 ${
                    isPasswordStrong
                      ? 'bg-green-500'
                      : Object.values(passwordStrength).filter(Boolean).length === 2
                      ? 'bg-yellow-500'
                      : 'bg-red-500'
                  }`}
                  style={{
                    width: `${(Object.values(passwordStrength).filter(Boolean).length / 3) * 100}%`
                  }}
                />
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <div className={`w-4 h-4 rounded-full flex items-center justify-center ${
                    passwordStrength.length ? 'bg-green-500' : 'bg-gray-300'
                  }`}>
                    {passwordStrength.length && <Check className="w-3 h-3 text-white" />}
                  </div>
                  <span className={`text-xs ${
                    passwordStrength.length ? 'text-green-600' : 'text-gray-500'
                  }`}>
                    Mínimo 8 caracteres
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div className={`w-4 h-4 rounded-full flex items-center justify-center ${
                    passwordStrength.hasNumber ? 'bg-green-500' : 'bg-gray-300'
                  }`}>
                    {passwordStrength.hasNumber && <Check className="w-3 h-3 text-white" />}
                  </div>
                  <span className={`text-xs ${
                    passwordStrength.hasNumber ? 'text-green-600' : 'text-gray-500'
                  }`}>
                    Incluye números
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div className={`w-4 h-4 rounded-full flex items-center justify-center ${
                    passwordStrength.hasSpecial ? 'bg-green-500' : 'bg-gray-300'
                  }`}>
                    {passwordStrength.hasSpecial && <Check className="w-3 h-3 text-white" />}
                  </div>
                  <span className={`text-xs ${
                    passwordStrength.hasSpecial ? 'text-green-600' : 'text-gray-500'
                  }`}>
                    Incluye símbolos (!@#$%^&*)
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Indicador de coincidencia */}
          {confirmPassword && (
            <div className="flex items-center gap-2 text-sm">
              {passwordsMatch ? (
                <>
                  <div className="w-4 h-4 bg-green-500 rounded-full flex items-center justify-center">
                    <Check className="w-3 h-3 text-white" />
                  </div>
                  <span className="text-green-600">Las contraseñas coinciden</span>
                </>
              ) : (
                <>
                  <div className="w-4 h-4 bg-red-500 rounded-full flex items-center justify-center">
                    <span className="text-white text-xs">✕</span>
                  </div>
                  <span className="text-red-600">Las contraseñas no coinciden</span>
                </>
              )}
            </div>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">
              {error}
            </div>
          )}

          <div className="flex gap-3 pt-4">
            <button
              type="button"
              onClick={handleSubmit}
              disabled={loading || !isPasswordStrong || !passwordsMatch}
              className="flex-1 bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white py-3 rounded-xl font-semibold transition-all shadow-lg shadow-blue-200 hover:shadow-xl disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Actualizando...' : 'Cambiar contraseña'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-6 bg-gray-100 hover:bg-gray-200 text-gray-700 py-3 rounded-xl font-semibold transition-colors"
            >
              Cancelar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}