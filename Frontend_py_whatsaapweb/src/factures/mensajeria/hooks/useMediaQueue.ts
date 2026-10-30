import { useRef, useState, useCallback } from 'react';
import { downloadMediaAPI, getMediaInfoAPI } from '../services/mediaService';
import { getMediaUrl as buildMediaUrl } from '../../../shared/utils/urls';

/**
 * Hook para gestionar una cola de descargas de media (videos, documentos, etc).
 * Garantiza que solo una descarga ocurra a la vez.
 */
type OnFinish = (url?: string, error?: any) => void;
interface QueueItem {
  messageId: string;
  onFinish?: OnFinish;
}

export function useMediaQueue() {
  const queue = useRef<QueueItem[]>([]);
  const [downloading, setDownloading] = useState(false);
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});

  const processQueue = useCallback(async () => {
    if (downloading || queue.current.length === 0) return;
    setDownloading(true);
    const { messageId, onFinish } = queue.current[0];
    try {
      // Primero intentamos obtener metadata/info del media. Muchos backends
      // modernos devuelven una URL pública en lugar del binario cuando la
      // petición está autenticada. Si existe, usamos esa URL directamente.
      let handled = false;
      try {
        const info = await getMediaInfoAPI(messageId);
        // El backend devuelve { mediaUrl, filename, mimetype }
        if (info?.mediaUrl && typeof info.mediaUrl === 'string') {
          const resolved = buildMediaUrl(info.mediaUrl);
          setMediaUrls(prev => ({ ...prev, [messageId]: resolved }));
          if (onFinish) onFinish(resolved);
          handled = true;
        }
      } catch (infoErr) {
        // Ignoramos errores al intentar obtener info y pasamos al fallback
      }

      // Fallback: si no recibimos una URL pública, descargamos el blob
      if (!handled) {
        const blob = await downloadMediaAPI(messageId);
        const url = URL.createObjectURL(blob);
        setMediaUrls(prev => ({ ...prev, [messageId]: url }));
        if (onFinish) onFinish(url);
      }
    } catch (e) {
      if (onFinish) onFinish(undefined, e);
    } finally {
      queue.current.shift();
      setDownloading(false);
      setTimeout(processQueue, 0);
    }
  }, [downloading]);

  const enqueue = useCallback((messageId: string, onFinish?: OnFinish) => {
    queue.current.push({ messageId, onFinish });
    setTimeout(processQueue, 0);
  }, [processQueue]);

  const getMediaUrl = useCallback((messageId: string) => {
    return mediaUrls[messageId];
  }, [mediaUrls]);

  return { enqueue, getMediaUrl };
}
