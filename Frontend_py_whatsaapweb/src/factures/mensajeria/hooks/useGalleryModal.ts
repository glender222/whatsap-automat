import { useState, useCallback } from 'react';
import type { WhatsAppMessage } from '../../../shared/types/wsp';

/**
 * Hook para gestionar el modal de galería de imágenes
 * Principio de Responsabilidad Única: Solo maneja el estado de la galería
 */
export function useGalleryModal() {
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryImages, setGalleryImages] = useState<WhatsAppMessage[]>([]);
  const [galleryAllMedia, setGalleryAllMedia] = useState<WhatsAppMessage[]>([]);
  const [galleryUserInfo, setGalleryUserInfo] = useState<{
    name: string;
    number: string;
    photoUrl?: string | null;
  }>({ name: '', number: '' });
  const [galleryIndex, setGalleryIndex] = useState(0);

  // Abrir galería de imágenes
  const handleOpenGallery = useCallback((
    clickedMsg: WhatsAppMessage,
    messages: WhatsAppMessage[],
    userInfo: { name: string; number: string; photoUrl?: string | null }
  ) => {
    const images = messages.filter(m => m.type === "image");
    const allMedia = messages.filter(m => m.mediaUrl);
    const idx = images.findIndex(img => img.id === clickedMsg.id);
    
    setGalleryImages(images);
    setGalleryAllMedia(allMedia);
    setGalleryUserInfo(userInfo);
    setGalleryIndex(idx === -1 ? 0 : idx);
    setGalleryOpen(true);
  }, []);

  // Cerrar galería
  const closeGallery = useCallback(() => {
    setGalleryOpen(false);
  }, []);

  return {
    galleryOpen,
    galleryImages,
    galleryAllMedia,
    galleryUserInfo,
    galleryIndex,
    handleOpenGallery,
    closeGallery
  };
}
