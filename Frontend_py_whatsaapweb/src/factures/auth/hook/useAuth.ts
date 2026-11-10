import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { authService, logoutSession } from "../services/authService";
import { saveSession } from "../../../shared/auth/session";
import type { login } from "../types/logTypes";
import type { User } from "../../../shared/types/user.types";

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Nota: La inicialización de WhatsApp se realiza manualmente desde la pantalla de Settings
  const navigate = useNavigate();

  const login = async (credentials: login) => {
    try {
  setLoading(true);
  setError(null);
      
      console.log('🚀 Iniciando proceso de login...');
      const response = await authService.login(credentials);
      
      saveSession(response.user, response.accessToken, response.refreshToken);
      setUser(response.user);

      // Navegar inmediatamente después del login exitoso
      console.log('🔄 Navegando a /gestion-web...');
      navigate("/gestion-web");
      
  // Nota: Inicialización de WhatsApp ahora se realiza manualmente desde la pantalla de Settings
  // para que el usuario (ADMIN) inicie el flujo de afiliación explícitamente.
  // Se mantiene el estado por compatibilidad, pero no ejecutamos la inicialización automática aquí.
      
    } catch (err) {
      console.error('❌ Error en login:', err);
      setError(err instanceof Error ? err.message : "Error al iniciar sesión");
    } finally {
      setLoading(false);
    }
  };

  // Nota: La inicialización de WhatsApp se realiza desde la pantalla de 'Settings' mediante
  // la acción explícita de 'Afiliar'. Por eso no mantenemos una inicialización automática aquí.

  // Eliminar función register porque no existe en authService

  const logout = async () => {
    if (!await logoutSession()) return;
    setUser(null);
    navigate("/auth/login");
  };

  return {
    user,
    loading,
    error,
    login,
    logout,
    isAuthenticated: authService.isAuthenticated(),
  };
}
