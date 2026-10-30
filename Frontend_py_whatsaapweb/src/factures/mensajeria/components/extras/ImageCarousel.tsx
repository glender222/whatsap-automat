import React from 'react';

import type { WhatsAppMessage } from '../../../../shared/types/wsp';
import { getMediaUrl as buildMediaUrl } from '../../../../shared/utils/urls';

interface ImageCarouselProps {
  images: WhatsAppMessage[];
  currentIndex: number;
  setCurrentIndex: (idx: number) => void;
}

const ImageCarousel: React.FC<ImageCarouselProps> = ({
  images,
  currentIndex,
  setCurrentIndex
}) => {
  const prev = () => setCurrentIndex((currentIndex - 1 + images.length) % images.length);
  const next = () => setCurrentIndex((currentIndex + 1) % images.length);

  if (!images.length) return null;
  const image = images[currentIndex];
  const url = buildMediaUrl(image.mediaUrl || '');

  return (
    <div className="flex items-center justify-center w-full h-full relative">
      {/* Flecha izquierda */}
      {images.length > 1 && (
        <button
          className="absolute left-6 top-1/2 transform -translate-y-1/2 text-white text-4xl"
          onClick={prev}
        >
          ‹
        </button>
      )}
      <img
        src={url}
        alt={image.filename || ""}
        className="rounded-lg max-w-[700px] max-h-[85vh] object-contain shadow-lg border"
        style={{ background: "#fff" }}
      />
      {/* Flecha derecha */}
      {images.length > 1 && (
        <button
          className="absolute right-6 top-1/2 transform -translate-y-1/2 text-white text-4xl"
          onClick={next}
        >
          ›
        </button>
      )}
    </div>
  );
};

export default ImageCarousel;