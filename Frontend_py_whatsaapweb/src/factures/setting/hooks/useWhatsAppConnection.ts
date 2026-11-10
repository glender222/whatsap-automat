import { readSession } from "../../../shared/auth/session";
import { useState, useEffect } from 'react';
import SocketService from '../../../utils/socket';
import { WhatsAppService } from '../services/whatsappService';
import type { WhatsAppConnectionState } from '../types/settings.types';

/**
 * Hook personalizado para manejar la conexión de WhatsApp
 */
export const useWhatsAppConnection = () => {
  const [state, setState] = useState<WhatsAppConnectionState>({
    numeroAfiliado: null,
    qrUrl: null,
    afiliando: false,
    loggingOut: false,
    showLogoutAnimation: false
  });

  // Obtiene el número afiliado
  const fetchNumeroAfiliado = async () => {
    const numero = await WhatsAppService.fetchNumeroAfiliado();
    if (numero) {
      setState(prev => ({ ...prev, numeroAfiliado: numero }));
    }
  };

  // Polling para detectar afiliación (esperando QR scan)
  useEffect(() => {
    let interval: NodeJS.Timeout;
    let attempts = 0;
    const maxAttempts = 90; // Máximo 3 minutos (90 * 2s)
    
    if (state.afiliando && !state.numeroAfiliado) {
      console.log('🔍 Esperando que escanees el QR...');
      
      interval = setInterval(async () => {
        attempts++;
        
        if (attempts > maxAttempts) {
          console.error('❌ Timeout: No se detectó conexión después de 3 minutos');
          clearInterval(interval);
          setState(prev => ({
            ...prev,
            afiliando: false,
            qrUrl: null
          }));
          alert('Timeout: No se detectó la conexión. Por favor intenta nuevamente.');
          return;
        }

        // Solo loggear cada 15 intentos (30 segundos)
        if (attempts % 15 === 0) {
          console.log(`⏳ Esperando conexión... (${attempts * 2}s)`);
        }

        const numero = await WhatsAppService.fetchNumeroAfiliado();
        
        if (numero) {
          console.log('✅ ¡WhatsApp conectado! Número:', numero);
          setState(prev => ({
            ...prev,
            numeroAfiliado: numero,
            afiliando: false,
            qrUrl: null
          }));
          clearInterval(interval);
        }
      }, 2000);
      
      return () => clearInterval(interval);
    }
    
    return () => clearInterval(interval);
  }, [state.afiliando, state.numeroAfiliado]);

  // Iniciar afiliación
  const handleAfiliar = async () => {
    console.log('🟢 Iniciando proceso de afiliación...');
    
    // Verificar que haya token
    const token = readSession().accessToken;
    if (!token) {
      alert('Error: No estás autenticado. Inicia sesión primero.');
      return;
    }

    // Intentar obtener el socket o conectarlo si no existe
    let socket = SocketService.getInstance().getSocket();
    
    // Si no hay socket, intentar conectar
    if (!socket) {
      console.log('🔌 Socket no existe, conectando...');
      socket = SocketService.getInstance().connect();
      
      // Esperar un poco para que establezca conexión
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // Verificar nuevamente después de intentar conectar
    if (!socket) {
      console.warn('⚠️ Socket no se pudo crear');
      alert('Error: No se pudo conectar al servidor. Por favor recarga la página.');
      return;
    }

    if (!socket.connected) {
      console.log('⏳ Esperando conexión del socket...');
      // Esperar a que conecte (máximo 5 segundos)
      let waitTime = 0;
      while (!socket.connected && waitTime < 5000) {
        await new Promise(resolve => setTimeout(resolve, 100));
        waitTime += 100;
      }
      
      if (!socket.connected) {
        console.warn('⚠️ Socket no se conectó después de esperar');
        alert('Error: No se pudo establecer conexión con el servidor. Por favor recarga la página.');
        return;
      }
    }
    
    console.log('✅ Socket conectado:', socket.id);
    
    // Marcar inicio de flujo (mantener la animación)
    setState(prev => ({
      ...prev,
      afiliando: true,
      qrUrl: null,
      numeroAfiliado: null
    }));

    try {
      // 1) Inicializar la sesión en el backend y esperar respuesta explícita
      console.log('📡 Enviando petición de inicialización de sesión (POST /whatsapp/init) ...');

      // Añadimos reintentos para tolerar demoras del backend al crear la sesión
      const maxInitRetries = 3; // número de reintentos adicionales
      const retryDelayMs = 4000; // 4 segundos entre reintentos

      let initResult: { success: boolean; message?: string } | null = null;
      for (let attempt = 0; attempt <= maxInitRetries; attempt++) {
        if (attempt > 0) {
          console.log(`⏳ Reintentando inicialización (${attempt}/${maxInitRetries}) después de ${retryDelayMs}ms`);
          // mantener la UI en estado afiliando mientras reintentamos
          await new Promise(res => setTimeout(res, retryDelayMs));
        }

        initResult = await WhatsAppService.initializeWhatsApp();

        // Si fue exitoso, rompemos el bucle
        if (initResult && initResult.success) break;

        // Si el error no parece ser transitorio (p. ej. token inválido), no reintentar
        const msg = String(initResult?.message || '').toLowerCase();
        const transient = msg.includes('conexión') || msg.includes('no hay respuesta') || msg.includes('servicio no disponible') || msg.includes('timeout') || msg.includes('error de conexión');
        if (!transient) {
          console.warn('⚠️ Error no transitorio durante init, no se reintentará:', initResult?.message);
          break;
        }
      }

      // Verificar respuesta esperada
      if (!initResult || !initResult.success) {
        console.error('❌ Inicialización fallida tras reintentos:', initResult?.message);
        setState(prev => ({ ...prev, afiliando: false }));
        // Mensaje más amigable que explique que hubo reintentos
        alert(`Error al inicializar sesión: ${initResult?.message || 'Respuesta inválida'}. Se intentó reintentar varias veces.`);
        return;
      }

      // Asegurarnos que el backend indicó que la inicialización comenzó y que debemos escanear el QR
      const expectedPhrase = 'Inicialización de sesión comenzada';
      if (!initResult.message || !initResult.message.includes(expectedPhrase)) {
        console.warn('⚠️ Mensaje de inicialización inesperado:', initResult.message);
        // Proceder de todas formas, pero loguear
      }

      console.log('✅ Inicialización aceptada por el backend. Ahora solicitando QR...');

      // 2) Solicitar QR (solo después de que init haya respondido)
      const qrResult = await WhatsAppService.requestQR();

      if (!qrResult.success) {
        console.error('❌ Error al solicitar QR después de init:', qrResult.message);
        setState(prev => ({ ...prev, afiliando: false }));
        alert(`Error: ${qrResult.message}`);
        return;
      }

      // Si recibimos QR en la respuesta HTTP, mostrarla; si no, quedamos esperando por socket
      if (qrResult.qr) {
        console.log('✅ QR recibido por HTTP después de init');
        setState(prev => ({ ...prev, qrUrl: qrResult.qr || null }));
      } else {
        console.log('⏳ QR no recibido por HTTP; esperando evento socket (se mantiene la animación)');
        // El QR llegará por el evento 'qr' del socket y el hook useSocketEvents debe llamar updateState
      }
    } catch (error) {
      console.error('❌ Error en el proceso de afiliación:', error);
      setState(prev => ({ ...prev, afiliando: false }));
      alert('Error al inicializar WhatsApp. Por favor intenta nuevamente.');
    }
  };

  // Cerrar sesión
  const handleDesafiliar = async () => {
    if (state.loggingOut) return;

    console.log('🔴 Iniciando logout...');
    setState(prev => ({
      ...prev,
      loggingOut: true,
      showLogoutAnimation: true
    }));

    try {
      const socket = SocketService.getInstance().getSocket();

      // Primero intentar llamar al endpoint de logout para cerrar sesión en backend
      try {
        const res = await WhatsAppService.logout();
        if (!res.success) {
          console.warn('⚠️ Logout API respondió con error:', res.message);
        } else {
          console.log('✅ Logout API exitoso:', res.message);
        }
      } catch (err) {
        console.warn('⚠️ Error llamando API de logout:', err);
      }

      // Emitir evento socket por compatibilidad con backend que espere evento
      if (socket && socket.connected) {
        socket.emit('logout');
      }

      // El backend híbrido maneja todo el almacenamiento - no hay localStorage WhatsApp que limpiar
      const clearLocalWhatsAppData = () => {
        console.log('🧹 Backend híbrido limpiará automáticamente los datos obsoletos');
        // Asegurar que forzamos una recarga limpia si el backend se cayó feo y desconfiguró la BD local (opcional)
        // window.location.reload(); 
      };

      // Reset UI rápidamente
      setTimeout(() => {
        setState({
          numeroAfiliado: null,
          qrUrl: null,
          afiliando: false,
          loggingOut: false,
          showLogoutAnimation: false
        });

        // Backend híbrido maneja la limpieza automáticamente
        clearLocalWhatsAppData();
      }, 500);
    } catch (err: any) {
      setState(prev => ({
        ...prev,
        loggingOut: false,
        showLogoutAnimation: false
      }));
      alert('Error al procesar el cierre de sesión: ' + err?.message);
    }
  };

  // Actualizar estados desde eventos externos
  const updateState = (updates: Partial<WhatsAppConnectionState>) => {
    setState(prev => ({ ...prev, ...updates }));
  };

  return {
    ...state,
    fetchNumeroAfiliado,
    handleAfiliar,
    handleDesafiliar,
    updateState
  };
};
