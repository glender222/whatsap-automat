/**
 * Hook para gestionar fotos de perfil de chats
 * Usa IndexedDB para cache y maneja errores silenciosamente
 */

import { useState, useEffect } from 'react';
import { fetchProfilePhoto, getCachedProfilePhotos } from '../services/profilePhotoService';

/**
 * Hook para obtener la foto de perfil de un solo chat
 */
export function useProfilePhoto(chatId: string | null | undefined) {
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!chatId) {
      setPhotoUrl(null);
      return;
    }

    let cancelled = false;
    setLoading(true);

    fetchProfilePhoto(chatId)
      .then((url) => {
        if (!cancelled) {
          setPhotoUrl(url);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPhotoUrl(null);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [chatId]);

  return { photoUrl, loading };
}

/**
 * Hook para obtener todas las fotos de perfil desde cache
 */
export function useCachedProfilePhotos() {
  const [photos, setPhotos] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    getCachedProfilePhotos()
      .then((map) => {
        if (!cancelled) {
          setPhotos(map);
          setLoading(false);
        }
      })
      .catch((err) => {
        console.error('Error cargando fotos de perfil desde cache:', err);
        if (!cancelled) {
          setPhotos(new Map());
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { photos, loading };
}
