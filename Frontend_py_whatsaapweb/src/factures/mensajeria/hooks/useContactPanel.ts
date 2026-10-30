import { useState, useCallback } from 'react';
import type { WhatsAppMessage, WhatsAppChat } from '../../../shared/types/wsp';
import { api } from '../../../shared/axios/http';

/**
 * Hook para gestionar el panel de información de contacto
 * Principio de Responsabilidad Única: Solo maneja el estado del panel de contacto
 */
export function useContactPanel() {
  const [contactPanelOpen, setContactPanelOpen] = useState(false);
  const [contactPanelMounted, setContactPanelMounted] = useState(false);
  const [contactMedia, setContactMedia] = useState<WhatsAppMessage[]>([]);
  const [contactUserInfo, setContactUserInfo] = useState<{
    name: string;
    number: string;
    photoUrl?: string | null;
  }>({ name: '', number: '' });

  // Función para formatear el número afiliado
  const formatNumeroAfiliado = (chatId: string): string => {
    let numero = chatId.split('@')[0];
    if (numero.startsWith('51')) {
      numero = numero.substring(2);
    }
    return numero;
  };

  // Mostrar panel de información del contacto
  const handleShowContactInfo = useCallback(async (chatId: string, chats: WhatsAppChat[]) => {
    try {
      const response = await api.get<{ success: boolean; data: any[]; total: number }>(
        `/chats/${encodeURIComponent(chatId)}/messages`
      );
      
      const msgs = response.data?.data || [];
      const media = msgs.filter((m: any) => m.mediaUrl);
      setContactMedia(media);
      
      const chat = chats.find(c => c.id === chatId);
      setContactUserInfo({
        name: chat?.name || '',
        number: formatNumeroAfiliado(chatId),
        photoUrl: chat?.photoUrl || undefined
      });
      
      // Montar y luego abrir para animación
      setContactPanelMounted(true);
      setTimeout(() => setContactPanelOpen(true), 20);
    } catch (err) {
      console.error('Error fetching contact media:', err);
    }
  }, []);

  // Cerrar panel de contacto
  const closeContactPanel = useCallback(() => {
    setContactPanelOpen(false);
    setTimeout(() => setContactPanelMounted(false), 300);
  }, []);

  return {
    contactPanelOpen,
    contactPanelMounted,
    contactMedia,
    contactUserInfo,
    handleShowContactInfo,
    closeContactPanel
  };
}
