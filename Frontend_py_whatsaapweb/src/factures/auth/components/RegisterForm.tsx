import { useState, useEffect } from "react";
import { Eye, EyeOff, Mail, Lock, User, Check, ArrowLeft, X, CheckCircle, AlertCircle } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { userService } from "../../../shared/services/userService";
import { useAuthJotai } from '../../../jotai/middleware/useAuthJotai';
import { useUserRoleJotai } from '../../../jotai/middleware/useUserRoleJotai';

export default function RegisterForm() {
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const navigate = useNavigate();
  const { saveAuth } = useAuthJotai();
  const { saveUserRole } = useUserRoleJotai();

  const [formData, setFormData] = useState({
    name: "",
    email: "",
    password: "",
    confirmPassword: "",
    acceptTerms: false,
  });

  const [loading, setLoading] = useState(false);
  const [notification, setNotification] = useState<{
    show: boolean;
    type: 'success' | 'error';
    message: string;
  }>({
    show: false,
    type: 'success',
    message: ''
  });
  const [passwordStrength, setPasswordStrength] = useState({
    length: false,
    hasNumber: false,
    hasSpecial: false,
  });

  useEffect(() => {
    if (notification.show) {
      const timer = setTimeout(() => {
        setNotification({ ...notification, show: false });
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [notification.show]);

  const showNotification = (type: 'success' | 'error', message: string) => {
    setNotification({ show: true, type, message });
  };

  const handlePasswordChange = (password: string) => {
    setFormData({ ...formData, password });
    setPasswordStrength({
      length: password.length >= 8,
      hasNumber: /\d/.test(password),
      hasSpecial: /[!@#$%^&*(),.?":{}|<>]/.test(password),
    });
  };

  const isPasswordStrong = Object.values(passwordStrength).every(Boolean);
  const passwordsMatch =
    formData.password === formData.confirmPassword &&
    formData.confirmPassword !== "";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!isPasswordStrong) {
      showNotification('error', 'La contraseña no cumple con los requisitos de seguridad');
      return;
    }
    if (!passwordsMatch) {
      showNotification('error', 'Las contraseñas no coinciden');
      return;
    }
    if (!formData.acceptTerms) {
      showNotification('error', 'Debes aceptar los términos y condiciones');
      return;
    }

    try {
      setLoading(true);

      // CAMBIO: Ahora el registro retorna tokens automáticamente
      const response = await userService.register({
        nombre: formData.name,
        email: formData.email,
        password: formData.password,
      });

      // 1. Guardar en Estado Global (Jotai) + LocalStorage
      // Esto sincroniza toda la app: socket, axios interceptors, etc.
      saveAuth(response.user, response.accessToken, response.refreshToken);

      // 2. Establecer rol (Nuevos registros son ADMIN por defecto)
      // Si el backend no devuelve rol, asumimos ADMIN por ser registro de cuenta nueva
      const role = response.user.rol === 'ADMIN' ? 'ADMIN' : 'EMPLEADO';
      saveUserRole(role);

      showNotification('success', `¡Bienvenido ${response.user.nombre}! Tu cuenta fue creada con éxito.`);

      // 3. Redirigir según el rol (Igual que en Login)
      setTimeout(() => {
        if (role === 'ADMIN') {
          navigate("/dashboard");
        } else {
          navigate("/gestion-web/inicio");
        }
      }, 1500);

    } catch (error: any) {
      console.error("Error al registrar usuario:", error);
      showNotification('error', error.message || 'No se pudo completar el registro');
    } finally {
      setLoading(false);
    }
  };

  const handleBack = () => navigate("/");

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-2 sm:p-4">
      {/* Notificación Toast */}
      <div
        className={`fixed top-4 right-4 z-50 transform transition-all duration-500 ease-out ${notification.show
          ? 'translate-x-0 opacity-100'
          : 'translate-x-full opacity-0'
          }`}
      >
        <div
          className={`flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg min-w-[300px] max-w-md ${notification.type === 'success'
            ? 'bg-green-500 text-white'
            : 'bg-red-500 text-white'
            }`}
        >
          {notification.type === 'success' ? (
            <CheckCircle className="w-5 h-5 flex-shrink-0" />
          ) : (
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
          )}
          <p className="text-sm font-medium flex-1">{notification.message}</p>
          <button
            onClick={() => setNotification({ ...notification, show: false })}
            className="hover:bg-white/20 rounded p-1 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-xl w-full max-w-5xl overflow-hidden relative">
        {/* Botón de atrás */}
        <button
          type="button"
          onClick={handleBack}
          className="absolute right-0 top-0 bg-[#0d1740] hover:bg-[#172a50] w-16 h-16 flex items-center justify-center rounded-tr-2xl z-10 transition-colors"
          aria-label="Volver"
        >
          <ArrowLeft className="w-8 h-8 text-white" strokeWidth={2.5} />
        </button>

        <div className="flex flex-col md:flex-row">
          {/* Panel izquierdo */}
          <div className="hidden md:flex md:w-1/2 bg-white p-6 lg:p-12 flex-col items-center justify-center border-r border-gray-100">
            <div className="relative mb-6">
              <div className="w-64 h-48 relative">
                <svg
                  className="w-full h-full text-green-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 280 200"
                >
                  <rect x="40" y="60" width="200" height="120" rx="8" strokeWidth="3" />
                  <rect x="60" y="80" width="50" height="40" rx="4" strokeWidth="2" />
                  <rect x="130" y="80" width="50" height="40" rx="4" strokeWidth="2" />
                  <rect x="200" y="80" width="30" height="40" rx="4" strokeWidth="2" />
                  <rect x="80" y="140" width="120" height="20" rx="4" strokeWidth="2" />
                </svg>
              </div>
              <div className="absolute -top-4 -right-4 w-16 h-16 bg-green-500 rounded-full flex items-center justify-center shadow-lg">
                <div className="w-10 h-10 bg-white rounded-full flex items-center justify-center">
                  <span className="text-green-500 text-lg font-bold">W</span>
                </div>
              </div>
            </div>
            <h3 className="text-2xl font-bold text-center mb-2">
              Gestione sus pedidos de mensajería
            </h3>
            <p className="text-gray-600 text-center">de forma eficiente</p>
          </div>

          {/* Panel derecho */}
          <div className="md:w-1/2 p-6 sm:p-8 md:p-12">
            <h2 className="text-2xl sm:text-3xl font-bold mb-4 sm:mb-6">Registro</h2>

            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Nombre */}
              <div className="relative">
                <User className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
                <input
                  type="text"
                  placeholder="Nombre"
                  value={formData.name}
                  onChange={(e) =>
                    setFormData({ ...formData, name: e.target.value })
                  }
                  className="w-full pl-12 pr-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                  required
                />
              </div>

              {/* Correo */}
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
                <input
                  type="email"
                  placeholder="Correo electrónico"
                  value={formData.email}
                  onChange={(e) =>
                    setFormData({ ...formData, email: e.target.value })
                  }
                  className="w-full pl-12 pr-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                  required
                />
              </div>

              {/* Contraseña */}
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
                <input
                  type={showPassword ? "text" : "password"}
                  placeholder="Contraseña"
                  value={formData.password}
                  onChange={(e) => handlePasswordChange(e.target.value)}
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

              {/* Confirmar contraseña */}
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
                <input
                  type={showConfirmPassword ? "text" : "password"}
                  placeholder="Confirmar contraseña"
                  value={formData.confirmPassword}
                  onChange={(e) =>
                    setFormData({ ...formData, confirmPassword: e.target.value })
                  }
                  className="w-full pl-12 pr-12 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                  required
                />
                <button
                  type="button"
                  onClick={() =>
                    setShowConfirmPassword(!showConfirmPassword)
                  }
                  className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  {showConfirmPassword ? (
                    <EyeOff className="w-5 h-5" />
                  ) : (
                    <Eye className="w-5 h-5" />
                  )}
                </button>
                {formData.confirmPassword && (
                  <div className="absolute right-12 top-1/2 transform -translate-y-1/2">
                    {passwordsMatch ? (
                      <Check className="w-5 h-5 text-green-500" />
                    ) : (
                      <span className="text-red-500 text-xs">✗</span>
                    )}
                  </div>
                )}
              </div>

              {/* Indicador de seguridad */}
              {formData.password && (
                <div className="space-y-2">
                  <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all duration-300 ${isPasswordStrong
                        ? "bg-green-500"
                        : Object.values(passwordStrength).filter(Boolean).length === 2
                          ? "bg-yellow-500"
                          : "bg-red-500"
                        }`}
                      style={{
                        width: `${(Object.values(passwordStrength).filter(Boolean).length / 3) * 100}%`
                      }}
                    />
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <div className={`w-4 h-4 rounded-full flex items-center justify-center ${passwordStrength.length ? "bg-green-500" : "bg-gray-300"
                        }`}>
                        {passwordStrength.length && <Check className="w-3 h-3 text-white" />}
                      </div>
                      <span className={`text-xs ${passwordStrength.length ? "text-green-600" : "text-gray-500"
                        }`}>
                        Mínimo 8 caracteres
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className={`w-4 h-4 rounded-full flex items-center justify-center ${passwordStrength.hasNumber ? "bg-green-500" : "bg-gray-300"
                        }`}>
                        {passwordStrength.hasNumber && <Check className="w-3 h-3 text-white" />}
                      </div>
                      <span className={`text-xs ${passwordStrength.hasNumber ? "text-green-600" : "text-gray-500"
                        }`}>
                        Incluye números
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className={`w-4 h-4 rounded-full flex items-center justify-center ${passwordStrength.hasSpecial ? "bg-green-500" : "bg-gray-300"
                        }`}>
                        {passwordStrength.hasSpecial && <Check className="w-3 h-3 text-white" />}
                      </div>
                      <span className={`text-xs ${passwordStrength.hasSpecial ? "text-green-600" : "text-gray-500"
                        }`}>
                        Incluye símbolos (!@#$%^&*)
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Términos */}
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={formData.acceptTerms}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      acceptTerms: e.target.checked,
                    })
                  }
                  className="w-4 h-4 mt-1 text-green-600 border-gray-300 rounded focus:ring-green-500"
                  required
                />
                <span className="text-sm text-gray-600">
                  Acepta los{" "}
                  <Link
                    to="/terms"
                    className="text-green-600 hover:underline"
                  >
                    Términos y condiciones
                  </Link>
                </span>
              </label>

              {/* Botón */}
              <button
                type="submit"
                disabled={loading}
                className={`w-full font-semibold py-3 rounded-lg transition-colors ${loading
                  ? "bg-green-300 cursor-not-allowed"
                  : "bg-green-500 hover:bg-green-600 text-white"
                  }`}
              >
                {loading ? "Creando cuenta..." : "Crear cuenta"}
              </button>

              {/* Link login */}
              <div className="text-center">
                <Link
                  to="/auth/login"
                  className="text-gray-600 hover:text-green-600 text-sm"
                >
                  Ya tengo cuenta
                </Link>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}