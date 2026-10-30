import { useState, useCallback } from 'react';
import { WhatsAppService } from '../../setting/services/whatsappService';

/**
 * Hook para gestionar la inicialización automática de WhatsApp
 * Principio de Responsabilidad Única: Solo maneja la inicialización de WhatsApp
 */
export function useWhatsAppInitialization() {
  const [whatsappInitializing, setWhatsappInitializing] = useState(false);
  const [initMessage, setInitMessage] = useState(
    'Conectando al servidor de WhatsApp... esto puede demorar un poco.'
  );

  // Inicializar WhatsApp
  const initializeWhatsApp = useCallback(async () => {
    setWhatsappInitializing(true);
    setInitMessage('Conectando al servidor de WhatsApp... esto puede demorar un poco. No te preocupes, es normal.');

    try {
      console.log('🔁 WhatsApp no activo - iniciando proceso de inicialización...');
      const initResult = await WhatsAppService.initializeWhatsApp();
      console.log('📣 Resultado inicialización WhatsApp:', initResult);
      
      setWhatsappInitializing(false);
      return initResult;
    } catch (initErr) {
      console.error('❌ Error inicializando WhatsApp automáticamente:', initErr);
      setWhatsappInitializing(false);
      throw initErr;
    }
  }, []);

  return {
    whatsappInitializing,
    initMessage,
    initializeWhatsApp
  };
}
