import React, { useState, useEffect } from 'react';
import UserMediaPanel from './UserMediaPanel';
import { getMediaUrl as buildMediaUrl } from '../../../../shared/utils/urls';
import type { WhatsAppMessage } from '../../../../shared/types/wsp';

// Removed local definition of WhatsAppMessage

interface UserInfo {
  name: string;
  number: string;
  photoUrl?: string | null;
}

interface ImageGalleryModalProps {
  open: boolean;
  images: WhatsAppMessage[];
  allMedia: WhatsAppMessage[];
  userInfo: UserInfo;
  initialIndex: number;
  onClose: () => void;
}

const ImageGalleryModal: React.FC<ImageGalleryModalProps> = ({
  open,
  images,
  allMedia,
  userInfo,
  initialIndex,
  onClose,
}) => {
  const [current, setCurrent] = useState(initialIndex);

  useEffect(() => {
    setCurrent(initialIndex);
  }, [initialIndex, images]);

  if (!open) return null;
  if (!images.length) return null;

  const currentImage = images[current];

  const prev = () => setCurrent((current - 1 + images.length) % images.length);
  const next = () => setCurrent((current + 1) % images.length);

  return (
    <div
      className="fixed inset-0 z-50 flex"
      style={{ background: 'rgba(0,0,0,0.94)' }}
    >
      {/* Panel central: imagen + navegación */}
      <div className="flex-1 flex items-center justify-center relative">
        <button
          className="absolute top-6 right-8 text-white text-3xl"
          onClick={onClose}
        >×</button>
        {images.length > 1 && (
          <button
            className="absolute left-8 top-1/2 transform -translate-y-1/2 text-white text-4xl"
            onClick={prev}
            aria-label="Anterior"
          >
            ‹
          </button>
        )}
        <img
          src={buildMediaUrl(currentImage.mediaUrl || '')}
          alt={currentImage.filename || ""}
          className="rounded-lg max-w-[700px] max-h-[80vh] object-contain shadow-lg border"
          style={{ background: "#fff" }}
        />
        {images.length > 1 && (
          <button
            className="absolute right-8 top-1/2 transform -translate-y-1/2 text-white text-4xl"
            onClick={next}
            aria-label="Siguiente"
          >
            ›
          </button>
        )}
      </div>
      {/* Panel derecho con info usuario y archivos */}
      <div className="w-[340px] bg-white h-full shadow-xl flex-shrink-0 flex flex-col">
        <UserMediaPanel
          userInfo={userInfo}
          allMedia={allMedia}
          onMediaClick={msg => {
            const imgIdx = images.findIndex(img => img.id === msg.id);
            if (imgIdx !== -1) setCurrent(imgIdx);
          }}
        />
      </div>
    </div>
  );
};

export default ImageGalleryModal;