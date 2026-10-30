import React from 'react';
import type { WhatsAppMessage } from '../../../../shared/types/wsp';
// Asegúrate de que esta ruta a tu FilePreview sea correcta
import FilePreview from '../../../../shared/components/FilePreview';
import { getMediaUrl } from '../../../../shared/utils/urls';

interface MediaViewerProps {
  media: WhatsAppMessage;
}

const MediaViewer: React.FC<MediaViewerProps> = ({ media }) => {
  const mime = media.mimetype ?? '';
  const name = media.filename ?? '';

  const url = getMediaUrl(media.mediaUrl || '');

  // Usamos la misma lógica robusta para detectar video
  // ✅ EXPANDIDO: Más formatos de video soportados
  const isVideo = mime.startsWith('video/') || (name && name.match(/\.(mp4|webm|ogg|mov|avi|mkv|flv|wmv|m4v|3gp|3gpp|asf|mpg|mpeg|m2v|m4v|f4v|f4p|f4a|f4b)$/i));

  if (isVideo) {
    // Si es video, usamos FilePreview (que tiene ReactPlayer)
    // Usamos la URL del servidor directamente para el streaming
    return (
      <FilePreview
        url={url}
        mimeType={mime}
        fileName={name}
      />
    );
  }

  // Si no, es una imagen
  return (
    <img
      src={url}
      alt={media.filename || ""}
      className="rounded-lg max-w-[700px] max-h-[80vh] object-contain shadow-lg border"
      style={{ background: "#fff" }} // Fondo blanco para PNGs
    />
  );
};

export default MediaViewer;