import { useState } from "react";
import { Eye, EyeOff, Mail, Lock, ArrowLeft } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { authService } from "../services/authService";
import { useAuthJotai } from '../../../jotai/middleware/useAuthJotai';
import { useUserRoleJotai } from '../../../jotai/middleware/useUserRoleJotai';
import { useGlobalTransition } from '../../../jotai/middleware/useGlobalTransition';
import GlobalTransition from '../../../shared/components/GlobalTransition';

export default function LoginForm() {
  const [showPassword, setShowPassword] = useState(false);
  const [username, setUsername] = useState(""); // Puede ser email o usuario
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const { saveAuth } = useAuthJotai();
  const { saveUserRole } = useUserRoleJotai();
  const { show, message, showTransition, hideTransition } = useGlobalTransition();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Validar que los campos no estén vacíos
    if (!username.trim() || !password.trim()) {
      setError("Por favor completa todos los campos");
      return;
    }

    try {
      setLoading(true);
      const result = await authService.login({ email: username, password });

      // Guardar usuario y tokens en jotai y localStorage
      saveAuth(result.user, result.accessToken, result.refreshToken);
      // Guardar rol en jotai y localStorage
      if (result.user && result.user.rol) {
        const role = result.user.rol === 'ADMIN' ? 'ADMIN' : 'EMPLEADO';
        saveUserRole(role);
      }

      showTransition('Bienvenido...');
      // Mostrar pantalla de transición
      setTimeout(() => {
        hideTransition();
        // Redirigir según el rol
        if (result.user && result.user.rol === 'ADMIN') {
          navigate("/dashboard");
        } else {
          navigate("/gestion-web/inicio");
        }
      }, 1500);
    } catch (error: any) {
      const errorMessage = error.message || "No se pudo iniciar sesión";
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const handleBack = () => navigate("/");

  return (
    <>
      <GlobalTransition show={show} message={message} zIndex={9999} />

      <div className={`min-h-screen bg-gray-50 flex items-center justify-center p-2 sm:p-4`}>
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 sm:p-8 relative">
          {/* Botón de atrás */}
          <button
            type="button"
            onClick={handleBack}
            className="absolute right-0 top-0 bg-[#0d1740] hover:bg-[#172a50] w-16 h-16 flex items-center justify-center rounded-tr-2xl transition-colors"
            aria-label="Volver"
          >
            <ArrowLeft className="w-8 h-8 text-white" strokeWidth={2.5} />
          </button>

          <h2 className="text-2xl sm:text-3xl font-bold text-center mb-6 sm:mb-8">Iniciar sesión</h2>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Campo de usuario/email */}
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
              <input
                type="text"
                placeholder="Usuario o correo electrónico"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full pl-12 pr-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                required
              />
            </div>

            {/* Campo de contraseña */}
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
              <input
                type={showPassword ? "text" : "password"}
                placeholder="Contraseña"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full pl-12 pr-12 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
              </button>
            </div>

            {/* Recordarme */}
            <div className="flex items-center justify-between text-sm">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  className="w-4 h-4 text-green-600 border-gray-300 rounded focus:ring-green-500"
                />
                <span className="text-gray-600">Recordarme</span>
              </label>
              <Link to="/auth/forgot-password" className="text-gray-600 hover:text-green-600">
                Olvidé mi contraseña
              </Link>
            </div>

            {/* Mensaje de error */}
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-center">
                <div className="text-red-700">
                  <span className="text-sm font-medium">❌ Error:</span>
                  <p className="text-xs mt-1">{error}</p>
                </div>
              </div>
            )}

            {/* Botón */}
            <button
              type="submit"
              disabled={loading}
              className={`w-full font-semibold py-3 rounded-lg transition-colors ${
                loading
                  ? "bg-green-300 cursor-not-allowed"
                  : "bg-green-500 hover:bg-green-600 text-white"
              }`}
            >
              {loading ? "Ingresando..." : "Iniciar sesión"}
            </button>

            {/* Link a crear cuenta */}
            <div className="text-center">
              <Link to="/auth/register" className="text-gray-600 hover:text-green-600 text-sm">
                Crear cuenta
              </Link>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}