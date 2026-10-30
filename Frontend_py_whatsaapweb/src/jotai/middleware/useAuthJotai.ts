import { useAtom } from 'jotai';
import { accessTokenAtom, refreshTokenAtom, userAtom } from '../slices/authAtoms';
import SocketService from '../../utils/socket';

export function useAuthJotai() {
  const [accessToken, setAccessToken] = useAtom(accessTokenAtom);
  const [refreshToken, setRefreshToken] = useAtom(refreshTokenAtom);
  const [user, setUser] = useAtom(userAtom);
  
  // Nota: La inicialización de WhatsApp no se hace automáticamente aquí.
  // El flujo debe iniciarse explícitamente desde Settings -> Afiliar.

  // Guardar tokens y usuario en localStorage y en jotai
  const saveAuth = (userData: any, accessToken: string, refreshToken: string) => {
    console.log('🚀 [AuthJotai] Guardando autenticación...');
    
    setUser(userData);
    setAccessToken(accessToken);
    setRefreshToken(refreshToken);
    localStorage.setItem('accessToken', accessToken);
    localStorage.setItem('refreshToken', refreshToken);
    localStorage.setItem('auth', JSON.stringify({ user: userData, accessToken, refreshToken }));
    
    console.log('✅ [AuthJotai] Tokens guardados correctamente');
    
    // Conectar socket
    console.log('🔌 [AuthJotai] Conectando Socket.IO...');
    SocketService.getInstance().connect();
    
    // Nota: No se inicializa WhatsApp automáticamente. El usuario debe hacerlo desde Settings -> Afiliar
  };

  // Limpiar tokens y usuario
  const clearAuth = () => {
    console.log('🧹 [AuthJotai] Limpiando autenticación...');
    
  setUser(null);
  setAccessToken(null);
  setRefreshToken(null);
    
    // Desconectar socket
    console.log('🔌 [AuthJotai] Desconectando Socket.IO...');
    SocketService.getInstance().disconnect();
    
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('auth');
    
    console.log('✅ [AuthJotai] Autenticación limpiada correctamente');
  };

  return {
    user,
    accessToken,
    refreshToken,
  // whatsapp init is manual via Settings -> Afiliar
    saveAuth,
    clearAuth,
  // initializeWhatsAppAsync removed; init must be triggered from Settings
  };
}
