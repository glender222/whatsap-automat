import { useCallback, useEffect, useRef } from 'react';
import { useAtom } from 'jotai';
import { chatsAtom, loadingChatsAtom } from '../../../jotai/slices/messagesAtoms';
import type { Tag } from '../types/tagTypes';
import * as tagsService from '../services/tagsService';
import type { WhatsAppChat } from '../../../shared/types/wsp';
import { parseTimestamp } from '../../../shared/types/wsp';

interface UseChatsManagementOptions {
  tags: Tag[];
  selectedCategory: string;
}

/**
 * Hook para gestionar la carga y recarga de chats
 * Implementa carga progresiva por batches para mejor UX
 * 
 * @note Los timestamps ahora se parsean de forma robusta usando parseTimestamp()
 *       lo cual maneja correctamente los diferentes formatos de v1.34.4+
 */
export function useChatsManagement({
  tags,
  selectedCategory
}: UseChatsManagementOptions) {
  const [chats, setChats] = useAtom(chatsAtom);
  const [isLoadingChats, setIsLoadingChats] = useAtom(loadingChatsAtom);
  const isLoadingRef = useRef<boolean>(false);

  // Tamaño de cada batch para carga progresiva
  const BATCH_SIZE = 10;
  // Delay entre batches para animación fluida (ms)
  const BATCH_DELAY = 50;

  // Función para normalizar los datos de chat
  // IMPORTANTE: Usar parseTimestamp para manejar formatos de v1.34.4+
  const normalizeChats = (data: unknown[]): WhatsAppChat[] => {
    console.log('🔍 normalizeChats INPUT:', data.slice(0, 2)); // Debug
    return (data as Record<string, unknown>[]).map((chat: Record<string, unknown>): WhatsAppChat => ({
      id: String(chat.id || ''),
      name: String(chat.name || ''), // El backend ya envía el nombre correcto
      profilePhotoUrl: chat.profilePhotoUrl as string | null,
      lastMessageTimestamp: parseTimestamp(chat.lastMessageTimestamp) || 0,
      lastMessagePreview: (chat.lastMessagePreview as string) ?? null,
      unreadCount: typeof chat.unreadCount === 'number' ? chat.unreadCount : 0,
      isGroup: Boolean(chat.isGroup),
    }));
  };

  // Función interna para cargar chats progresivamente
  // Los chats existentes permanecen visibles mientras se sincronizan los nuevos
  const loadChatsProgressive = async (tagId: string) => {
    if (isLoadingRef.current) {
      console.log('⏳ Ya hay una carga en progreso, omitiendo...');
      return;
    }

    isLoadingRef.current = true;
    setIsLoadingChats(true);

    // ✅ NO limpiamos los chats existentes - permanecen visibles
    // Los chats actuales se mantienen mientras sincronizamos en segundo plano

    try {
      console.log(`🔄 Sincronizando chats para la etiqueta ${tagId}...`);

      const response = await tagsService.getChatsByTag(tagId);
      const data = response.data;

      if (!data || data.length === 0) {
        console.log('📭 No hay chats en esta categoría');
        setChats([]);
        setIsLoadingChats(false);
        isLoadingRef.current = false;
        return;
      }

      // Normalizar todos los datos
      const allChats = normalizeChats(data);

      // ✅ Cargar en batches para efecto progresivo
      // Los chats van apareciendo conforme llegan
      for (let i = 0; i < allChats.length; i += BATCH_SIZE) {
        const batch = allChats.slice(0, i + BATCH_SIZE);

        // Reemplazar con el batch acumulado (no agregar duplicados)
        setChats(batch);

        // Pequeño delay entre batches para animación fluida
        if (i + BATCH_SIZE < allChats.length) {
          await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
        }
      }

      console.log(`✅ ${allChats.length} chats sincronizados`);

    } catch (error: any) {
      console.error(`❌ Error sincronizando chats:`, error?.message);
      // En caso de error, NO limpiamos - mantenemos los chats que teníamos
    } finally {
      setIsLoadingChats(false);
      isLoadingRef.current = false;
    }
  };

  // Función pública para recargar manualmente
  const reloadChats = useCallback(async (tagId?: string) => {
    const actualTagId = tagId || tags.find(t => t.name === selectedCategory)?.id;
    if (actualTagId) {
      await loadChatsProgressive(actualTagId);
    }
  }, [tags, selectedCategory]);

  // Cargar chats cuando cambie la categoría seleccionada
  useEffect(() => {
    const currentTag = tags.find(t => t.name === selectedCategory);
    if (currentTag) {
      loadChatsProgressive(currentTag.id);
    }
  }, [selectedCategory, tags]);

  return {
    chats,
    setChats,
    reloadChats,
    isLoadingChats
  };
}
